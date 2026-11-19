//! 供应商余额 / 额度查询。
//!
//! 设计取舍（对照 cc-switch 与 cockpit-tools 的成熟做法）：
//! - 原生厂商按 host 白名单匹配，URL 全硬编码，不做路径猜测；
//! - 中转站走协议探测：先 new-api 的 key 用量接口，再 OpenAI 计费兼容口，最后 sub2api 的 /usage；
//! - **绝不猜倍率**：只有响应明确给了 `display.unit` 才当货币数额，否则单位留空由前端不加符号；
//! - 失败分「瞬时」（网络/超时/读体中断）与「确定性」（鉴权、404、格式非法）两类，
//!   前者前端保留上次成功值，后者立即显示并清空。
//!
//! 单位口径来自真实响应，不按站点常见倍率换算——换算错了是系统性算错，
//! 比"查不到"更糟。

use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, Instant};

use super::apply_system_proxy;

const BALANCE_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BalanceResult {
    pub ok: bool,
    /// 命中的探测通道：deepseek / siliconflow / openrouter / moonshot / new_api / sub2api / unsupported
    pub mode: String,
    /// 货币或百分比单位。空字符串表示站点没说单位，前端不加符号。
    pub unit: String,
    pub total: Option<f64>,
    pub used: Option<f64>,
    pub remaining: Option<f64>,
    pub unlimited: bool,
    /// 额度过期时间（Unix 秒）
    pub expires_at: Option<i64>,
    /// 给用户看的结论；成功时为空串
    pub message: String,
    /// 失败是否属于瞬时错误：前端据此决定保留还是清空上一次成功值
    pub transient: bool,
    pub latency_ms: u64,
}

fn fail(mode: &str, message: impl Into<String>, transient: bool, latency_ms: u64) -> BalanceResult {
    BalanceResult {
        ok: false,
        mode: mode.to_string(),
        message: message.into(),
        transient,
        latency_ms,
        ..BalanceResult::default()
    }
}

/// 数值字段兼容 number 与字符串（中转站两种都常见）。
fn num_at(value: &Value, path: &[&str]) -> Option<f64> {
    let mut cur = value;
    for key in path {
        cur = cur.get(*key)?;
    }
    cur.as_f64()
        .or_else(|| cur.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
        .filter(|n| n.is_finite())
}

fn str_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = value;
    for key in path {
        cur = cur.get(*key)?;
    }
    cur.as_str().map(str::trim).filter(|s| !s.is_empty())
}

fn bool_at(value: &Value, path: &[&str]) -> Option<bool> {
    let mut cur = value;
    for key in path {
        cur = cur.get(*key)?;
    }
    cur.as_bool()
}

/// 拆出 origin 与 path，去掉尾部斜杠。用户填的地址可能带或不带协议、可能带 /v1。
fn split_origin(host: &str) -> (String, String) {
    let raw = host.trim();
    let with_scheme = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let trimmed = with_scheme.trim_end_matches('/').to_string();
    if let Some(scheme_end) = trimmed.find("://") {
        let after_scheme = scheme_end + 3;
        if let Some(slash) = trimmed[after_scheme..].find('/') {
            let origin = trimmed[..after_scheme + slash].to_string();
            let path = trimmed[after_scheme + slash..].to_string();
            return (origin, path);
        }
    }
    (trimmed, String::new())
}

/// 回环 / 本机地址：这类供应商（自建网关、本地面板）绝不能走系统代理，
/// 否则开了 Clash 之类工具的机器会直接连不上。
fn is_local_host(host: &str) -> bool {
    let lower = host.trim().to_lowercase();
    lower.contains("://127.0.0.1")
        || lower.contains("://localhost")
        || lower.contains("://[::1]")
        || lower.starts_with("127.0.0.1")
        || lower.starts_with("localhost")
        || lower.starts_with("[::1]")
}

fn build_client(host: &str) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(BALANCE_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(8))
        .user_agent("AnyBridge-ProviderBalance");
    let builder = if is_local_host(host) {
        builder.no_proxy()
    } else {
        apply_system_proxy(builder)
    };
    builder.build().map_err(|e| e.to_string())
}

struct Fetched {
    status: u16,
    body: Value,
}

/// 发 GET 并解析 JSON。
///
/// 刻意不用 `resp.json()`：reqwest 会把「读体失败」也包装成 decode 错误，
/// 无法与「响应体确实不是 JSON」区分，而这正是瞬时/确定性分流的依据。
async fn fetch_json(client: &reqwest::Client, url: &str, key: &str) -> Result<Fetched, (String, bool)> {
    let resp = match client.get(url).bearer_auth(key).send().await {
        Ok(resp) => resp,
        Err(err) => return Err((format!("网络请求失败：{err}"), true)),
    };
    let status = resp.status().as_u16();
    let raw = match resp.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => return Err((format!("读取响应失败：{err}"), true)),
    };
    match serde_json::from_slice::<Value>(&raw) {
        Ok(body) => Ok(Fetched { status, body }),
        Err(_) => {
            let preview = String::from_utf8_lossy(&raw[..raw.len().min(120)]).replace('\n', " ");
            Err((format!("响应不是 JSON（HTTP {status}）：{preview}"), false))
        }
    }
}

fn host_lower(host: &str) -> String {
    host.trim().to_lowercase()
}

/// 原生厂商探测：命中返回通道名。
fn native_mode(host: &str) -> Option<&'static str> {
    let lower = host_lower(host);
    if lower.contains("api.deepseek.com") {
        Some("deepseek")
    } else if lower.contains("api.siliconflow.cn") || lower.contains("api.siliconflow.com") {
        Some("siliconflow")
    } else if lower.contains("openrouter.ai") {
        Some("openrouter")
    } else if lower.contains("api.moonshot.cn") || lower.contains("api.moonshot.ai") {
        Some("moonshot")
    } else {
        None
    }
}

// ── 原生通道 ──────────────────────────────────────────────
//
// 每家拆成「`*_at(client, url, …)` + 固定 URL 的薄包装」：
// URL 是参数而不是藏在函数体里的常量，测试才能把它指向本地服务，
// 覆盖「发请求 → 解析 → 归一化」整条链路，而不只是解析函数。
// 公开地址由包装固定，不随用户填的 host 变化；多区域站点靠 host 分派。

const DEEPSEEK_BALANCE_URL: &str = "https://api.deepseek.com/user/balance";
const SILICONFLOW_CN_USER_INFO_URL: &str = "https://api.siliconflow.cn/v1/user/info";
const SILICONFLOW_COM_USER_INFO_URL: &str = "https://api.siliconflow.com/v1/user/info";
const OPENROUTER_CREDITS_URL: &str = "https://openrouter.ai/api/v1/credits";
const MOONSHOT_CN_BALANCE_URL: &str = "https://api.moonshot.cn/v1/users/me/balance";
const MOONSHOT_AI_BALANCE_URL: &str = "https://api.moonshot.ai/v1/users/me/balance";

async fn query_deepseek_at(client: &reqwest::Client, url: &str, key: &str) -> BalanceResult {
    let started = Instant::now();
    let fetched = match fetch_json(client, url, key).await {
        Ok(value) => value,
        Err((message, transient)) => return fail("deepseek", message, transient, started.elapsed().as_millis() as u64),
    };
    let latency = started.elapsed().as_millis() as u64;

    if fetched.status == 401 || fetched.status == 403 {
        return fail("deepseek", "密钥鉴权失败（HTTP 401/403）", false, latency);
    }
    if fetched.status != 200 {
        return fail(
            "deepseek",
            format!("DeepSeek 返回 HTTP {}", fetched.status),
            false,
            latency,
        );
    }

    let infos = match fetched.body.get("balance_infos").and_then(Value::as_array) {
        Some(items) if !items.is_empty() => items,
        _ => return fail("deepseek", "响应里没有余额字段", false, latency),
    };
    // 优先人民币账户，多币种时只展示一项，避免把两个币种加在一起
    let picked = infos
        .iter()
        .find(|item| str_at(item, &["currency"]).map(|c| c.eq_ignore_ascii_case("CNY")).unwrap_or(false))
        .unwrap_or(&infos[0]);

    let currency = str_at(picked, &["currency"]).unwrap_or("").to_uppercase();
    let total = num_at(picked, &["total_balance"]);
    let granted = num_at(picked, &["granted_balance"]);
    let topped = num_at(picked, &["topped_up_balance"]);
    let available = bool_at(&fetched.body, &["is_available"]).unwrap_or(true);

    BalanceResult {
        ok: true,
        mode: "deepseek".into(),
        unit: currency,
        total: match (granted, topped) {
            (Some(g), Some(t)) => Some(g + t),
            _ => total,
        },
        used: None,
        remaining: total,
        unlimited: false,
        expires_at: None,
        message: if available {
            String::new()
        } else {
            "账户余额不足，DeepSeek 已标记为不可用".into()
        },
        transient: false,
        latency_ms: latency,
    }
}

async fn query_deepseek(client: &reqwest::Client, key: &str) -> BalanceResult {
    query_deepseek_at(client, DEEPSEEK_BALANCE_URL, key).await
}

async fn query_siliconflow_at(
    client: &reqwest::Client,
    url: &str,
    unit: &str,
    key: &str,
) -> BalanceResult {
    let started = Instant::now();
    let fetched = match fetch_json(client, url, key).await {
        Ok(value) => value,
        Err((message, transient)) => {
            return fail("siliconflow", message, transient, started.elapsed().as_millis() as u64)
        }
    };
    let latency = started.elapsed().as_millis() as u64;

    if fetched.status == 401 || fetched.status == 403 {
        return fail("siliconflow", "密钥鉴权失败（HTTP 401/403）", false, latency);
    }
    if fetched.status != 200 {
        return fail(
            "siliconflow",
            format!("硅基流动返回 HTTP {}", fetched.status),
            false,
            latency,
        );
    }
    let Some(remaining) = num_at(&fetched.body, &["data", "totalBalance"]) else {
        return fail("siliconflow", "响应里没有余额字段", false, latency);
    };

    BalanceResult {
        ok: true,
        mode: "siliconflow".into(),
        unit: unit.to_string(),
        total: None,
        used: None,
        remaining: Some(remaining),
        unlimited: false,
        expires_at: None,
        message: String::new(),
        transient: false,
        latency_ms: latency,
    }
}

async fn query_siliconflow(client: &reqwest::Client, host: &str, key: &str) -> BalanceResult {
    if host_lower(host).contains("api.siliconflow.com") {
        query_siliconflow_at(client, SILICONFLOW_COM_USER_INFO_URL, "USD", key).await
    } else {
        query_siliconflow_at(client, SILICONFLOW_CN_USER_INFO_URL, "CNY", key).await
    }
}

async fn query_openrouter_at(client: &reqwest::Client, url: &str, key: &str) -> BalanceResult {
    let started = Instant::now();
    let fetched = match fetch_json(client, url, key).await {
        Ok(value) => value,
        Err((message, transient)) => {
            return fail("openrouter", message, transient, started.elapsed().as_millis() as u64)
        }
    };
    let latency = started.elapsed().as_millis() as u64;

    if fetched.status == 401 || fetched.status == 403 {
        return fail("openrouter", "密钥鉴权失败（HTTP 401/403）", false, latency);
    }
    if fetched.status != 200 {
        return fail(
            "openrouter",
            format!("OpenRouter 返回 HTTP {}", fetched.status),
            false,
            latency,
        );
    }

    // 有 envelope 与无 envelope 两种返回都兼容
    let data = fetched.body.get("data").unwrap_or(&fetched.body);
    let credits = num_at(data, &["total_credits"]);
    let usage = num_at(data, &["total_usage"]);
    let Some(credits) = credits else {
        return fail("openrouter", "响应里没有额度字段", false, latency);
    };
    let used = usage.unwrap_or(0.0);

    BalanceResult {
        ok: true,
        mode: "openrouter".into(),
        unit: "USD".into(),
        total: Some(credits),
        used: Some(used),
        remaining: Some((credits - used).max(0.0)),
        unlimited: false,
        expires_at: None,
        message: String::new(),
        transient: false,
        latency_ms: latency,
    }
}

async fn query_openrouter(client: &reqwest::Client, key: &str) -> BalanceResult {
    query_openrouter_at(client, OPENROUTER_CREDITS_URL, key).await
}

async fn query_moonshot_at(
    client: &reqwest::Client,
    url: &str,
    unit: &str,
    key: &str,
) -> BalanceResult {
    let started = Instant::now();
    let fetched = match fetch_json(client, url, key).await {
        Ok(value) => value,
        Err((message, transient)) => {
            return fail("moonshot", message, transient, started.elapsed().as_millis() as u64)
        }
    };
    let latency = started.elapsed().as_millis() as u64;

    if fetched.status == 401 || fetched.status == 403 {
        return fail("moonshot", "密钥鉴权失败（HTTP 401/403）", false, latency);
    }
    if fetched.status != 200 {
        return fail("moonshot", format!("Kimi 返回 HTTP {}", fetched.status), false, latency);
    }
    let Some(remaining) = num_at(&fetched.body, &["data", "available_balance"]) else {
        return fail("moonshot", "响应里没有余额字段", false, latency);
    };

    BalanceResult {
        ok: true,
        mode: "moonshot".into(),
        unit: unit.to_string(),
        total: None,
        used: None,
        remaining: Some(remaining),
        unlimited: false,
        expires_at: None,
        message: String::new(),
        transient: false,
        latency_ms: latency,
    }
}

async fn query_moonshot(client: &reqwest::Client, host: &str, key: &str) -> BalanceResult {
    if host_lower(host).contains("api.moonshot.ai") {
        query_moonshot_at(client, MOONSHOT_AI_BALANCE_URL, "USD", key).await
    } else {
        query_moonshot_at(client, MOONSHOT_CN_BALANCE_URL, "CNY", key).await
    }
}

// ── 中转站面板 ────────────────────────────────────────────

/// new-api 的 key 级用量：优先读 `data.display`（站点自述单位）。
fn from_new_api_token_usage(body: &Value, latency: u64) -> Option<BalanceResult> {
    let data = body.get("data")?;
    let display = data.get("display");

    if let Some(display) = display {
        let unit = str_at(display, &["unit"]).map(|u| u.to_uppercase()).unwrap_or_default();
        let total = num_at(display, &["total"]);
        let used = num_at(display, &["used"]);
        let remaining = num_at(display, &["remaining"]);
        // 只给出的两项也能补齐第三项
        let total = total.or_else(|| match (used, remaining) {
            (Some(u), Some(r)) => Some(u + r),
            _ => None,
        });
        let used = used.or_else(|| match (total, remaining) {
            (Some(t), Some(r)) => Some((t - r).max(0.0)),
            _ => None,
        });
        let remaining = remaining.or_else(|| match (total, used) {
            (Some(t), Some(u)) => Some((t - u).max(0.0)),
            _ => None,
        });
        if total.is_some() || remaining.is_some() {
            return Some(BalanceResult {
                ok: true,
                mode: "new_api".into(),
                unit,
                total,
                used,
                remaining,
                unlimited: bool_at(data, &["unlimited_quota"]).unwrap_or(false),
                expires_at: nil_to_opt(data.get("expires_at")),
                message: String::new(),
                transient: false,
                latency_ms: latency,
            });
        }
    }

    // 没有 display 时只认「站点自己的额度计数」，不当货币换算
    let available = num_at(data, &["total_available"]);
    let granted = num_at(data, &["total_granted"]);
    if available.is_none() && granted.is_none() {
        return None;
    }
    Some(BalanceResult {
        ok: true,
        mode: "new_api".into(),
        unit: String::new(),
        total: granted,
        used: match (granted, available) {
            (Some(g), Some(a)) => Some((g - a).max(0.0)),
            _ => None,
        },
        remaining: available,
        unlimited: bool_at(data, &["unlimited_quota"]).unwrap_or(false),
        expires_at: nil_to_opt(data.get("expires_at")),
        message: String::new(),
        transient: false,
        latency_ms: latency,
    })
}

fn nil_to_opt(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(n) = value.as_i64() {
        // 秒与毫秒都出现过：小于 1e12 视为秒
        return Some(if n > 1_000_000_000_000 { n / 1000 } else { n });
    }
    value.as_str().and_then(|s| s.parse::<i64>().ok())
}

async fn try_new_api(client: &reqwest::Client, origin: &str, key: &str) -> Option<BalanceResult> {
    let started = Instant::now();

    // 1) key 级用量：最准，站点自述单位
    let token_url = format!("{origin}/api/usage/token/");
    if let Ok(fetched) = fetch_json(client, &token_url, key).await {
        if fetched.status == 200 {
            if let Some(result) =
                from_new_api_token_usage(&fetched.body, started.elapsed().as_millis() as u64)
            {
                return Some(result);
            }
        }
    }

    // 2) OpenAI 计费兼容口：subscription 与 usage 两段都要
    let subscription_url = format!("{origin}/dashboard/billing/subscription");
    let fetched = fetch_json(client, &subscription_url, key).await.ok()?;
    if fetched.status != 200 {
        return None;
    }
    let latency = started.elapsed().as_millis() as u64;
    let period = 30;
    let end = chrono::Utc::now().format("%Y-%m-%d");
    let start = (chrono::Utc::now() - chrono::Duration::days(period)).format("%Y-%m-%d");
    let usage_url = format!("{origin}/dashboard/billing/usage?start_date={start}&end_date={end}");
    let usage = fetch_json(client, &usage_url, key).await.ok();

    let hard = num_at(&fetched.body, &["hard_limit_usd"])
        .or_else(|| num_at(&fetched.body, &["soft_limit_usd"]))
        .or_else(|| num_at(&fetched.body, &["system_hard_limit_usd"]));
    // 100000000 是 new-api 表示「不限量」的哨兵值
    let unlimited = matches!(hard, Some(value) if (value - 100_000_000.0).abs() < f64::EPSILON);
    let total = if unlimited { None } else { hard };
    let used_cents = usage
        .as_ref()
        .filter(|u| u.status == 200)
        .and_then(|u| num_at(&u.body, &["total_usage"]));
    // total_usage 单位是「分」
    let used = used_cents.map(|cents| cents / 100.0);

    if total.is_none() && used.is_none() {
        return None;
    }

    Some(BalanceResult {
        ok: true,
        mode: "new_api".into(),
        unit: "USD".into(),
        total,
        used,
        remaining: match (total, used) {
            (Some(t), Some(u)) => Some((t - u).max(0.0)),
            (None, Some(_)) => None,
            _ => total,
        },
        unlimited,
        expires_at: None,
        message: String::new(),
        transient: false,
        latency_ms: latency,
    })
}

async fn try_sub2api(client: &reqwest::Client, base: &str, key: &str) -> Option<BalanceResult> {
    let started = Instant::now();
    let url = format!("{}/usage", base.trim_end_matches('/'));
    let fetched = fetch_json(client, &url, key).await.ok()?;
    if fetched.status != 200 {
        return None;
    }
    let latency = started.elapsed().as_millis() as u64;
    let body = &fetched.body;

    let unit = str_at(body, &["unit"])
        .or_else(|| str_at(body, &["quota", "unit"]))
        .map(|u| u.to_uppercase())
        .unwrap_or_default();
    let total = num_at(body, &["quota", "limit"]).or_else(|| num_at(body, &["quotaLimit"]));
    let used = num_at(body, &["quota", "used"]).or_else(|| num_at(body, &["quotaUsed"]));
    let remaining = num_at(body, &["quota", "remaining"]).or_else(|| num_at(body, &["remaining"]));

    if total.is_none() && used.is_none() && remaining.is_none() {
        return None;
    }

    Some(BalanceResult {
        ok: true,
        mode: "sub2api".into(),
        unit,
        total,
        used,
        remaining: remaining.or_else(|| match (total, used) {
            (Some(t), Some(u)) => Some((t - u).max(0.0)),
            _ => None,
        }),
        unlimited: bool_at(body, &["quota", "unlimited"]).unwrap_or(false),
        expires_at: nil_to_opt(body.get("expiresAt")).or_else(|| nil_to_opt(body.get("expires_at"))),
        message: String::new(),
        transient: false,
        latency_ms: latency,
    })
}

/// 查询供应商余额。`mode_hint` 非空时可跳过自动探测（用户在 UI 上手动指定过）。
#[tauri::command]
pub async fn query_provider_balance(
    host: String,
    api_key: String,
    mode_hint: Option<String>,
) -> Result<BalanceResult, String> {
    let key = api_key.trim().to_string();
    if key.is_empty() {
        return Ok(fail("unsupported", "这个供应商还没有填写密钥", false, 0));
    }
    let host_trimmed = host.trim().to_string();
    if host_trimmed.is_empty() {
        return Ok(fail("unsupported", "这个供应商还没有填写 API 地址", false, 0));
    }

    let client = build_client(&host_trimmed)?;
    let hint = mode_hint.unwrap_or_default().trim().to_string();

    // 用户显式指定的通道优先
    match hint.as_str() {
        "deepseek" => return Ok(query_deepseek(&client, &key).await),
        "siliconflow" => return Ok(query_siliconflow(&client, &host_trimmed, &key).await),
        "openrouter" => return Ok(query_openrouter(&client, &key).await),
        "moonshot" => return Ok(query_moonshot(&client, &host_trimmed, &key).await),
        _ => {}
    }

    // 原生厂商按 host 精确识别
    if let Some(mode) = native_mode(&host_trimmed) {
        return Ok(match mode {
            "deepseek" => query_deepseek(&client, &key).await,
            "siliconflow" => query_siliconflow(&client, &host_trimmed, &key).await,
            "openrouter" => query_openrouter(&client, &key).await,
            _ => query_moonshot(&client, &host_trimmed, &key).await,
        });
    }

    let (origin, path) = split_origin(&host_trimmed);
    let started = Instant::now();

    if hint != "sub2api" {
        if let Some(result) = try_new_api(&client, &origin, &key).await {
            return Ok(result);
        }
    }
    // sub2api 的用量口挂在用户填的 path 下（常见是 /v1）
    let base = if path.is_empty() {
        origin.clone()
    } else {
        format!("{origin}{path}")
    };
    if let Some(result) = try_sub2api(&client, &base, &key).await {
        return Ok(result);
    }

    Ok(fail(
        "unsupported",
        "该供应商未提供可识别的余额接口",
        false,
        started.elapsed().as_millis() as u64,
    ))
}

#[cfg(test)]
mod tests;
