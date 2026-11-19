use super::*;

#[test]
fn split_origin_keeps_scheme_and_path() {
    assert_eq!(
        split_origin("https://api.example.com/v1"),
        ("https://api.example.com".to_string(), "/v1".to_string())
    );
    assert_eq!(
        split_origin("api.example.com"),
        ("https://api.example.com".to_string(), String::new())
    );
    assert_eq!(
        split_origin("https://api.example.com/"),
        ("https://api.example.com".to_string(), String::new())
    );
}

#[test]
fn native_mode_matches_known_hosts_only() {
    assert_eq!(native_mode("https://api.deepseek.com/v1"), Some("deepseek"));
    assert_eq!(native_mode("https://openrouter.ai/api/v1"), Some("openrouter"));
    assert_eq!(native_mode("https://api.siliconflow.cn/v1"), Some("siliconflow"));
    assert_eq!(native_mode("https://api.moonshot.cn/v1"), Some("moonshot"));
    // 中转站不命中白名单，交给协议探测
    assert_eq!(native_mode("https://my-relay.example.com/v1"), None);
}

#[test]
fn new_api_display_uses_site_unit_without_guessing_multiplier() {
    let body = serde_json::json!({
        "data": {
            "display": { "total": 180, "used": 40, "remaining": 140, "unit": " cny " }
        }
    });
    let result = from_new_api_token_usage(&body, 3).expect("display 存在时必须解析成功");
    assert_eq!(result.unit, "CNY");
    assert_eq!(result.total, Some(180.0));
    assert_eq!(result.used, Some(40.0));
    assert_eq!(result.remaining, Some(140.0));
}

#[test]
fn new_api_without_display_leaves_unit_empty() {
    // 没有 display 时不能把原始 quota 当货币，单位必须留空
    let body = serde_json::json!({
        "data": { "total_granted": 900000000.0, "total_available": 700000000.0 }
    });
    let result = from_new_api_token_usage(&body, 3).expect("额度计数存在时必须解析成功");
    assert_eq!(result.unit, "");
    assert_eq!(result.total, Some(900000000.0));
    assert_eq!(result.remaining, Some(700000000.0));
    assert_eq!(result.used, Some(200000000.0));
}

#[test]
fn new_api_body_without_quota_returns_none() {
    let body = serde_json::json!({ "data": { "name": "nothing" } });
    assert!(from_new_api_token_usage(&body, 0).is_none());
}

#[test]
fn numeric_fields_accept_string_values() {
    // 中转站常把数字写成字符串
    let body = serde_json::json!({ "data": { "display": { "remaining": "12.50", "unit": "USD" } } });
    let result = from_new_api_token_usage(&body, 0).expect("字符串数值也要能解析");
    assert_eq!(result.remaining, Some(12.5));
}

/// 起一个只回固定 JSON 的本地服务，用于验证「协议探测 → 解析」整条链路，
/// 不依赖真实供应商密钥。
fn spawn_mock(routes: Vec<(&'static str, u16, &'static str)>) -> String {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").expect("绑定本地端口");
    let port = listener.local_addr().expect("取本地端口").port();
    std::thread::spawn(move || {
        // 单条探测链最多 3 次请求，多留几次余量
        for _ in 0..6 {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0u8; 4096];
            let read = stream.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..read]).to_string();
            // request-target 可能带 query（billing/usage 有 start_date/end_date），
            // 按路由匹配前先剥掉
            let target = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/");
            let path = target.split('?').next().unwrap_or("/").to_string();
            let (status, body) = routes
                .iter()
                .find(|(route, _, _)| *route == path)
                .map(|(_, status, body)| (*status, *body))
                .unwrap_or((404, "{}"));
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    format!("http://127.0.0.1:{port}")
}

#[tokio::test]
async fn billing_compatible_panel_is_detected_end_to_end() {
    let host = spawn_mock(vec![
        (
            "/dashboard/billing/subscription",
            200,
            r#"{"hard_limit_usd":100}"#,
        ),
        ("/dashboard/billing/usage", 200, r#"{"total_usage":2500}"#),
    ]);
    let result = query_provider_balance(host, "sk-test".to_string(), None)
        .await
        .expect("命令本身不应返回 Err");
    assert!(result.ok, "应查询成功，实际：{}", result.message);
    assert_eq!(result.mode, "new_api");
    assert_eq!(result.unit, "USD");
    assert_eq!(result.total, Some(100.0));
    // total_usage 的单位是「分」
    assert_eq!(result.used, Some(25.0));
    assert_eq!(result.remaining, Some(75.0));
}

#[tokio::test]
async fn key_usage_endpoint_wins_when_site_reports_display_unit() {
    let host = spawn_mock(vec![(
        "/api/usage/token/",
        200,
        r#"{"data":{"display":{"total":180,"used":40,"remaining":140,"unit":"CNY"}}}"#,
    )]);
    let result = query_provider_balance(host, "sk-test".to_string(), None)
        .await
        .expect("命令本身不应返回 Err");
    assert!(result.ok, "应查询成功，实际：{}", result.message);
    assert_eq!(result.mode, "new_api");
    assert_eq!(result.unit, "CNY");
    assert_eq!(result.total, Some(180.0));
    assert_eq!(result.remaining, Some(140.0));
}

#[tokio::test]
async fn panel_without_billing_endpoints_reports_unsupported() {
    // 三条通道全 404：必须给「未提供余额接口」，且属于确定性失败
    let host = spawn_mock(vec![]);
    let result = query_provider_balance(host, "sk-test".to_string(), None)
        .await
        .expect("命令本身不应返回 Err");
    assert!(!result.ok);
    assert_eq!(result.mode, "unsupported");
    assert!(!result.transient, "404 是确定性失败，不能当瞬时错误");
}

// ── 原生四家：把 URL 指到本地 mock，覆盖「请求 → 解析 → 归一化」整条链路 ──

fn test_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("测试 client 必须可创建")
}

#[tokio::test]
async fn deepseek_picks_cny_account_when_multiple_currencies() {
    let base = spawn_mock(vec![(
        "/user/balance",
        200,
        r#"{"is_available":true,"balance_infos":[
            {"currency":"USD","total_balance":"5.00","granted_balance":"0","topped_up_balance":"5.00"},
            {"currency":"CNY","total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"}
        ]}"#,
    )]);
    let url = format!("{base}/user/balance");
    let result = query_deepseek_at(&test_client(), &url, "sk-test").await;

    assert!(result.ok, "应解析成功：{}", result.message);
    // 多币种时取人民币账户，不把两个币种加在一起
    assert_eq!(result.unit, "CNY");
    assert_eq!(result.remaining, Some(110.0));
    // 总额 = 赠送 + 充值
    assert_eq!(result.total, Some(110.0));
}

#[tokio::test]
async fn deepseek_flags_insufficient_balance_without_failing() {
    let base = spawn_mock(vec![(
        "/user/balance",
        200,
        r#"{"is_available":false,"balance_infos":[{"currency":"CNY","total_balance":"0.00"}]}"#,
    )]);
    let url = format!("{base}/user/balance");
    let result = query_deepseek_at(&test_client(), &url, "sk-test").await;

    // 查到了就是查到了：余额不足是业务状态，不是查询失败
    assert!(result.ok);
    assert_eq!(result.remaining, Some(0.0));
    assert!(result.message.contains("余额不足"), "应给出余额不足提示");
}

#[tokio::test]
async fn siliconflow_keeps_region_unit() {
    let base = spawn_mock(vec![(
        "/v1/user/info",
        200,
        r#"{"code":20000,"data":{"balance":"0.88","chargeBalance":"88.00","totalBalance":"88.88"}}"#,
    )]);
    let cn = query_siliconflow_at(&test_client(), &format!("{base}/v1/user/info"), "CNY", "sk-test").await;
    assert!(cn.ok, "应解析成功：{}", cn.message);
    assert_eq!(cn.unit, "CNY");
    assert_eq!(cn.remaining, Some(88.88));

    // 同一个接口，国际站必须标 USD——币种靠站点分派，不能靠响应里猜
    let intl = query_siliconflow_at(&test_client(), &format!("{base}/v1/user/info"), "USD", "sk-test").await;
    assert_eq!(intl.unit, "USD");
}

#[tokio::test]
async fn openrouter_subtracts_usage_from_credits() {
    let base = spawn_mock(vec![(
        "/api/v1/credits",
        200,
        r#"{"data":{"total_credits":20,"total_usage":3.5}}"#,
    )]);
    let url = format!("{base}/api/v1/credits");
    let result = query_openrouter_at(&test_client(), &url, "sk-test").await;

    assert!(result.ok, "应解析成功：{}", result.message);
    assert_eq!(result.unit, "USD");
    assert_eq!(result.total, Some(20.0));
    assert_eq!(result.used, Some(3.5));
    assert_eq!(result.remaining, Some(16.5));
}

#[tokio::test]
async fn moonshot_reads_available_balance() {
    let base = spawn_mock(vec![(
        "/v1/users/me/balance",
        200,
        r#"{"data":{"available_balance":88.5,"voucher_balance":0,"cash_balance":88.5}}"#,
    )]);
    let url = format!("{base}/v1/users/me/balance");
    let result = query_moonshot_at(&test_client(), &url, "CNY", "sk-test").await;

    assert!(result.ok, "应解析成功：{}", result.message);
    assert_eq!(result.remaining, Some(88.5));
}

#[tokio::test]
async fn auth_failure_is_deterministic_not_transient() {
    let base = spawn_mock(vec![("/user/balance", 401, r#"{"error":"unauthorized"}"#)]);
    let url = format!("{base}/user/balance");
    let result = query_deepseek_at(&test_client(), &url, "sk-wrong").await;

    assert!(!result.ok);
    // 鉴权失败是确定性失败：界面必须立刻透出，不能保留上次的旧余额
    assert!(!result.transient, "401 不能被当成瞬时错误");
    assert!(result.message.contains("鉴权失败"), "应明确指出鉴权失败");
}

#[tokio::test]
async fn empty_key_or_host_is_rejected_without_any_request() {
    // 空密钥：不建 client、不发请求，直接给结论
    let no_key = query_provider_balance(
        "http://127.0.0.1:9".to_string(),
        "   ".to_string(),
        None,
    )
    .await
    .expect("命令本身不应返回 Err");
    assert!(!no_key.ok);
    assert_eq!(no_key.mode, "unsupported");
    assert_eq!(no_key.latency_ms, 0, "没发请求就不该有耗时");
    assert!(no_key.message.contains("密钥"));

    let no_host = query_provider_balance(String::new(), "sk-test".to_string(), None)
        .await
        .expect("命令本身不应返回 Err");
    assert!(!no_host.ok);
    assert!(no_host.message.contains("API 地址"));
}
