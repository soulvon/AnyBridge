//! Antigravity IDE 设置页 / Agent 面板的运行期汉化（CDP 注入）。
//!
//! 为什么文件注入不可行：这两块界面由内置扩展 `agy` 用 `<iframe>` 载入
//! `agy.exe --hub` 提供的本地 Web 应用（`http://127.0.0.1:<port>/settings-standalone`）。
//! 它是跨源 iframe，且前端资源编译进约 210MB 的 agy.exe（磁盘上没有对应文件），
//! workbench.html 注入天然够不到（实测 IDE 1.107.0）。
//!
//! 唯一可行路径：以 `--remote-debugging-port` 启动 IDE，通过 CDP 找到该应用的
//! iframe target，把同一套词库引擎注入进去；页面刷新/导航后由 keeper 补注入。
//!
//! 安全说明：调试端口只监听 127.0.0.1，但本机任意进程都能借它读取/控制 IDE。
//! 因此是否以汉化模式启动由用户显式点击按钮决定，不在后台擅自重启 IDE。

use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

/// 调试端口。固定值便于 keeper 复用；探测时会校验 UA 含 AntigravityIDE，
/// 避免把别的 Electron 应用误当成自己的调试端口。
pub const CDP_PORT: u16 = 9333;

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityCdpStatus {
    /// 调试端口可用且确认是 Antigravity IDE
    pub available: bool,
    pub port: u16,
    /// 已注入的界面数（设置页/Agent 面板）
    pub injected: usize,
    /// 识别到的应用界面 target 数
    pub targets: usize,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CdpTarget {
    pub url: String,
    pub ws: String,
}

fn cdp_base() -> String {
    format!("http://127.0.0.1:{CDP_PORT}")
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("创建 CDP HTTP 客户端失败: {e}"))
}

/// 探测 `--remote-debugging-port` 是否就绪且属于 Antigravity IDE。
pub fn probe() -> Result<String, String> {
    let body = http_client()?
        .get(format!("{}/json/version", cdp_base()))
        .send()
        .map_err(|e| format!("调试端口未就绪（IDE 未以汉化模式启动？）: {e}"))?
        .text()
        .map_err(|e| format!("读取调试端口响应失败: {e}"))?;
    let v: Value = serde_json::from_str(&body).map_err(|e| format!("解析调试端口响应失败: {e}"))?;
    let ua = v.get("User-Agent").and_then(|x| x.as_str()).unwrap_or("");
    if !ua.contains("AntigravityIDE") {
        return Err(format!(
            "{CDP_PORT} 端口被其它程序占用，不是 Antigravity IDE 的调试端口"
        ));
    }
    let ws = v
        .get("webSocketDebuggerUrl")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    Ok(ws)
}

/// 该 target 是否是 Antigravity 的本地 Web 应用界面（设置页 / Agent 面板）。
///
/// 只认 127.0.0.1 + 扩展 iframe 的标记参数；浏览器控制页（/browser 那套）
/// 不属于 IDE 界面，注入了反而乱改其他网页，必须排除。
fn is_app_target(url: &str) -> bool {
    url.starts_with("http://127.0.0.1:")
        && (url.contains("/settings-standalone") || url.contains("extensionView=true"))
}

fn fetch_targets() -> Result<Vec<CdpTarget>, String> {
    let body = http_client()?
        .get(format!("{}/json/list", cdp_base()))
        .send()
        .map_err(|e| format!("读取 CDP 目标列表失败: {e}"))?
        .text()
        .map_err(|e| format!("读取 CDP 目标列表失败: {e}"))?;
    let list: Value = serde_json::from_str(&body).map_err(|e| format!("解析目标列表失败: {e}"))?;
    let mut out = Vec::new();
    if let Some(arr) = list.as_array() {
        for item in arr {
            let url = item.get("url").and_then(|x| x.as_str()).unwrap_or("");
            let ws = item
                .get("webSocketDebuggerUrl")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if url.is_empty() || ws.is_empty() {
                continue;
            }
            out.push(CdpTarget {
                url: url.to_string(),
                ws: ws.to_string(),
            });
        }
    }
    Ok(out)
}

/// 在指定 target 里执行一段 JS，返回 Runtime.evaluate 的 result。
fn eval_in_target(ws_url: &str, expression: &str) -> Result<Value, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("创建 CDP 运行时失败: {e}"))?;

    rt.block_on(async move {
        let (mut ws, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|e| format!("连接 CDP target 失败: {e}"))?;

        let req = json!({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": false
            }
        });
        ws.send(Message::Text(req.to_string().into()))
            .await
            .map_err(|e| format!("发送 CDP 请求失败: {e}"))?;

        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        loop {
            let next = tokio::time::timeout_at(deadline, ws.next())
                .await
                .map_err(|_| "等待 CDP 响应超时".to_string())?;
            let Some(msg) = next else {
                return Err("CDP 连接意外关闭".to_string());
            };
            let msg = msg.map_err(|e| format!("读取 CDP 响应失败: {e}"))?;
            let Message::Text(txt) = msg else { continue };
            let v: Value = serde_json::from_str(&txt).map_err(|e| format!("解析 CDP 响应失败: {e}"))?;
            if v.get("id").and_then(|x| x.as_u64()) != Some(1) {
                continue;
            }
            if let Some(err) = v.get("error") {
                return Err(format!("CDP 执行报错: {err}"));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    })
}

/// 对当前所有应用界面补注入（幂等：页面里已有标记就跳过）。
pub fn inject_once() -> Result<usize, String> {
    probe()?;
    let targets = fetch_targets()?;
    let app_targets: Vec<&CdpTarget> = targets.iter().filter(|t| is_app_target(&t.url)).collect();
    if app_targets.is_empty() {
        return Ok(0);
    }
    let script = super::app_localization::hans_script_for_cdp();
    let mut injected = 0usize;
    for t in app_targets {
        let has = eval_in_target(&t.ws, "!!window.__anybridgeCdpHans")?;
        if has.get("result").and_then(|r| r.get("value")).and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        let r = eval_in_target(&t.ws, &script)?;
        if let Some(ex) = r.get("exceptionDetails") {
            return Err(format!("注入脚本执行异常: {ex}"));
        }
        injected += 1;
    }
    Ok(injected)
}

/// 查询当前状态（给 UI 用）。任何一步失败都不静默：如实写进 message。
pub fn status() -> AntigravityCdpStatus {
    let mut st = AntigravityCdpStatus {
        port: CDP_PORT,
        ..Default::default()
    };
    if let Err(e) = probe() {
        st.message = Some(e);
        return st;
    }
    st.available = true;
    let targets = match fetch_targets() {
        Ok(t) => t,
        Err(e) => {
            st.message = Some(e);
            return st;
        }
    };
    let app: Vec<&CdpTarget> = targets.iter().filter(|t| is_app_target(&t.url)).collect();
    st.targets = app.len();
    for t in &app {
        if let Ok(r) = eval_in_target(&t.ws, "!!window.__anybridgeCdpHans") {
            if r.get("result")
                .and_then(|x| x.get("value"))
                .and_then(|v| v.as_bool())
                == Some(true)
            {
                st.injected += 1;
            }
        }
    }
    if st.targets == 0 {
        st.message = Some("调试端口已就绪，等待打开设置页或 Agent 面板".to_string());
    } else if st.injected < st.targets {
        st.message = Some("检测到界面尚未注入，正在补注入".to_string());
    }
    st
}

/// 后台补注入：只在「已启用汉化」且调试端口可用时工作。
///
/// 页面刷新/导航会清掉注入标记，所以必须持续巡检；没有端口时静默跳过，
/// 绝不打扰用户（正常启动的 IDE 没有调试端口是合法状态，不是错误）。
pub fn spawn_cdp_keeper() {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        loop {
            if super::app_localization::is_enabled("antigravity-ide") && probe().is_ok() {
                match inject_once() {
                    Ok(n) if n > 0 => {
                        eprintln!("[ag-cdp] 已注入 {n} 个界面（设置页/Agent 面板）");
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("[ag-cdp] 补注入跳过: {e}"),
                }
            }
            std::thread::sleep(Duration::from_secs(4));
        }
    });
}

#[tauri::command]
pub async fn get_antigravity_cdp_status() -> Result<AntigravityCdpStatus, String> {
    tauri::async_runtime::spawn_blocking(status)
        .await
        .map_err(|e| format!("查询注入状态失败: {e}"))
}

#[tauri::command]
pub async fn apply_antigravity_cdp_localization() -> Result<AntigravityCdpStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let injected = inject_once()?;
        let mut st = status();
        if injected > 0 {
            st.message = Some(format!("已注入 {injected} 个界面"));
        }
        Ok::<AntigravityCdpStatus, String>(st)
    })
    .await
    .map_err(|e| format!("注入任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_target_matcher_excludes_browser_surface() {
        // 设置页 / Agent 面板
        assert!(is_app_target(
            "http://127.0.0.1:64213/settings-standalone?extensionView=true&extensionVariant=vs-code"
        ));
        assert!(is_app_target(
            "http://127.0.0.1:64213/?extensionView=true&extensionVariant=vs-code"
        ));
        // 浏览器控制页（别的网页）绝不能注入
        assert!(!is_app_target("http://127.0.0.1:48883/"));
        // 非本地地址不碰
        assert!(!is_app_target("https://example.com/?extensionView=true"));
        // vscode webview 外壳不是目标（它只是 iframe 宿主）
        assert!(!is_app_target("vscode-webview://abc/index.html?id=1"));
    }

    #[test]
    fn injection_script_has_idempotence_guard() {
        let script = super::super::app_localization::hans_script_for_cdp();
        assert!(
            script.contains("__anybridgeCdpHans"),
            "必须带幂等标记，否则每次巡检都会叠加一个 MutationObserver"
        );
        assert!(
            script.contains("__anybridgeHansAuxWindow = true;"),
            "设置页没有 workbench 根节点，必须走辅助窗口快速启动分支"
        );
        assert!(script.contains("MutationObserver"), "引擎本体必须保留");
    }
}
