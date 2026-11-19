#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};
use tauri::AppHandle;
use super::*;
/// 启动常驻 watcher 后台线程。在 lib.rs setup 闭包里调一次。
/// 仅 Windows 有意义（Codex Desktop MSIX + CDP）；其它平台直接 no-op。
pub fn spawn_codex_desktop_watcher(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        std::thread::spawn(move || {
            watch_loop(app);
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

#[cfg(target_os = "windows")]
const WATCHER_INTERVAL: Duration = Duration::from_secs(3);
/// 补注入成功后冷却：防止频繁重复注入。
/// 之前 30s 太长，用户重开 Codex 后要等冷却到期才检测，体感慢。http_get_local
/// 修了 keep-alive 误判后，5s 足够 Codex 稳定。
#[cfg(target_os = "windows")]
const WATCHER_COOLDOWN_AFTER_SUCCESS: Duration = Duration::from_secs(5);
#[cfg(target_os = "windows")]
const WATCHER_COOLDOWN_AFTER_FAILURE: Duration = Duration::from_secs(30);

/// watcher 主循环：每 3 秒检查一次。
#[cfg(target_os = "windows")]
fn watch_loop(app: AppHandle) {
    let mut cooldown_until: Option<Instant> = None;
    loop {
        run_watcher_tick(&app, &mut cooldown_until);
        std::thread::sleep(WATCHER_INTERVAL);
    }
}

/// 单次检查逻辑。
/// watcher 只在 codex_needs_cdp_injection() 为 true 时工作：
/// injectModels=true 且 preserveOfficialAuth=false。
/// 否则整条 CDP 流程不触发——不检测 CDP、不补注入、不通知。
/// 且必须确认 Desktop UI 宿主在跑；仅有 app-server/CLI 不算。
/// CDP 不通时只发通知提示用户从 AnyBridge 启动，不自动 kill + 重启。
#[cfg(target_os = "windows")]
fn run_watcher_tick(app: &AppHandle, cooldown_until: &mut Option<Instant>) {
    if !codex_needs_cdp_injection() {
        *cooldown_until = None;
        return;
    }
    // Desktop UI 没在跑，不接管（绝不凭空 launch）
    if !codex_running() {
        *cooldown_until = None;
        return;
    }
    // 冷却期，不接管
    if let Some(until) = *cooldown_until {
        if Instant::now() < until {
            return;
        }
        eprintln!("[codex-desktop watcher] 冷却到期，恢复检测");
        *cooldown_until = None;
    }

    if cdp_listening_slow() {
        // CDP 通 → 检查 patch 是否在
        if sidecar_injection_present() {
            return; // 一切正常
        }
        // patch 没了 → 直接补 inject（不 kill）
        crate::commands::platforms::emit_switch_progress(
            app,
            "codex",
            "injecting",
            "正在自动补注入…",
        );
        match inject_via_sidecar() {
            Ok(_) => {
                eprintln!("[codex-desktop watcher] 已补注入自定义模型");
                *cooldown_until = Some(Instant::now() + WATCHER_COOLDOWN_AFTER_SUCCESS);
            }
            Err(e) => {
                eprintln!("[codex-desktop watcher] 补注入失败: {e}");
                *cooldown_until = Some(Instant::now() + WATCHER_COOLDOWN_AFTER_FAILURE);
            }
        }
        return;
    }

    // CDP 不通（用户手动打开 Codex，没带 CDP）→ 只通知，不接管
    eprintln!("[codex-desktop watcher] Codex Desktop 未以 CDP 模式运行，不自动接管");
    crate::commands::platforms::emit_switch_progress(
        app,
        "codex",
        "notify",
        "Codex 未以调试模式启动，自定义模型不可用",
    );
    *cooldown_until = Some(Instant::now() + WATCHER_COOLDOWN_AFTER_FAILURE);
}

