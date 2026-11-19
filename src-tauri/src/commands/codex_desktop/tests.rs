use super::*;
use std::io::{Read, Write};

// 真实网络行为：端口没监听时必须失败，且两个回环地址的失败原因都要在。
// 这就是 issue #38 的现场——用户当时只看到 [::1] 那条，真实 IPv4 原因被盖掉了。
#[test]
fn http_post_local_reports_every_loopback_failure() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let err = http_post_local(
        port,
        "/__byok/codex-cdp/inject",
        "{}",
        Duration::from_millis(400),
    )
    .expect_err("端口未监听时必须失败");
    assert!(
        err.contains(&format!("127.0.0.1:{port}")),
        "丢失 IPv4 失败原因: {err}"
    );
    assert!(
        err.contains(&format!("[::1]:{port}")),
        "丢失 IPv6 失败原因: {err}"
    );
    assert!(err.starts_with(&format!("无法连接 {port}")), "前缀漂移: {err}");
}

// 真实网络行为：服务在监听时必须能建连、发出 POST 并解析回包。
// 只改错误分支容易把成功路径的连通性一起改坏，这里用真 socket 盯住。
#[test]
fn http_post_local_posts_to_listening_server() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 2048];
            let _ = stream.read(&mut buf);
            let body = r#"{"ok":true,"message":"stub"}"#;
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
        }
    });
    let (status, body) = http_post_local(port, "/x", "{}", Duration::from_secs(3))
        .expect("测试服务在监听，不应连接失败");
    assert!(status.contains("200"), "状态行异常: {status}");
    assert!(body.contains("\"ok\":true"), "回包体异常: {body}");
    let _ = server.join();
}

// 双地址探测的错误必须逐条保留：只留最后一个会把真实原因（IPv4 被拒）盖掉，
// 让人误判成 IPv6 问题——issue #38 现场就是被这行误导的。
#[test]
fn connect_error_keeps_every_address_reason() {
    let errors = vec![
        "127.0.0.1:7450: 目标计算机积极拒绝".to_string(),
        "[::1]:7450: 目标计算机积极拒绝".to_string(),
    ];
    let text = connect_error(7450, &errors);
    assert!(text.contains("127.0.0.1:7450"), "丢失 IPv4 原因: {text}");
    assert!(text.contains("[::1]:7450"), "丢失 IPv6 原因: {text}");
    assert!(text.contains("7450"), "缺少端口: {text}");
}

// 用户可见主句三条硬约束（防回归到"啰嗦 + 漏翻 + 掺变量"）：
//   1) 不能换行、不掺 PID/端口 —— 否则整句命不中 i18n 字典；
//   2) 不超过 40 字 —— 界面文案保持克制，详情一律走第二行；
//   3) 不出现 CDP / sidecar / sqlite 等实现词。
#[test]
fn user_facing_messages_stay_short_and_translatable() {
    let mut all = vec![MSG_PROXY_UNAVAILABLE, MSG_INJECT_FAILED];
    #[cfg(target_os = "windows")]
    all.push(MSG_CDP_NOT_READY);
    for msg in all {
        assert!(!msg.contains('\n'), "主句不得换行: {msg}");
        assert!(!msg.contains("PID"), "主句不得掺运行时变量: {msg}");
        assert!(!msg.contains("7450"), "主句不得掺端口: {msg}");
        assert!(msg.chars().count() <= 40, "主句超过 40 字，请精简: {msg}");
        for banned in ["CDP", "sidecar", "sqlite", "state_5"] {
            assert!(!msg.contains(banned), "主句不得暴露实现细节 {banned}: {msg}");
        }
    }
}
