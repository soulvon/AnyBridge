//! 白色 Antigravity 桌面端增强插件冲突与功能重叠矩阵（唯一真源）。
//!
//! 将跨插件冲突划分为两级：
//! - `Exclusive`（硬互斥）：底层通道/DOM 注入互相破坏，不可并存；安装新插件前自动卸载已生效的对端。
//! - `Overlap`（功能重叠）：底层隔离可并存，但存在顶栏挂载、界面汉化或切号等能力重合，安装前需提醒并给出共存建议。

use serde::Serialize;

use super::cdp_themes::{CHUANBAN_THEME_ID, CODEX_THEME_ID};
use super::native_plugins::USAGE_MONITOR_ID;
use super::{EnhanceItemStatus, CONTEXT_VIEWER_ID};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictLevel {
    Exclusive,
    Overlap,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceConflict {
    pub peer_id: String,
    pub level: ConflictLevel,
    pub reason_code: String,
    pub reason: String,
    pub active: bool,
}

#[derive(Debug, Clone, Copy)]
struct ConflictRule {
    subject_id: &'static str,
    peer_id: &'static str,
    level: ConflictLevel,
    reason_code: &'static str,
    reason: &'static str,
}

/// 声明式冲突与重叠规则表（每一对 `(A, B)` 必须对称声明，由单测锁定对称性）。
const CONFLICT_RULES: &[ConflictRule] = &[
    // 1. 两款 CDP 主题守护进程硬互斥：均注入全局 CSS 变量与布局脚本并抢占调试通道。
    ConflictRule {
        subject_id: CODEX_THEME_ID,
        peer_id: CHUANBAN_THEME_ID,
        level: ConflictLevel::Exclusive,
        reason_code: "cdp_theme_daemon",
        reason: "同为本地 CDP 主题守护进程，并存会导致主题样式撕裂与重复注入；安装本插件前将自动卸载对方。",
    },
    ConflictRule {
        subject_id: CHUANBAN_THEME_ID,
        peer_id: CODEX_THEME_ID,
        level: ConflictLevel::Exclusive,
        reason_code: "cdp_theme_daemon",
        reason: "同为本地 CDP 主题守护进程，并存会导致主题样式撕裂与重复注入；安装本插件前将自动卸载对方。",
    },
    // 2. context-viewer ↔ usage-monitor：顶栏用量条、宿主汉化与 Windows 切号能力重叠。
    ConflictRule {
        subject_id: CONTEXT_VIEWER_ID,
        peer_id: USAGE_MONITOR_ID,
        level: ConflictLevel::Overlap,
        reason_code: "topbar_i18n_account",
        reason: "两者均默认挂载顶栏用量监控并提供界面汉化与多账号切换；并存时建议将 usage-monitor 改为仅侧边栏并只保留一处汉化。",
    },
    ConflictRule {
        subject_id: USAGE_MONITOR_ID,
        peer_id: CONTEXT_VIEWER_ID,
        level: ConflictLevel::Overlap,
        reason_code: "topbar_i18n_account",
        reason: "两者均默认挂载顶栏用量监控并提供界面汉化与多账号切换；并存时建议将 usage-monitor 改为仅侧边栏并只保留一处汉化。",
    },
    // 3. context-viewer ↔ codex-theme：汉化与用量统计重叠（后装 codex-theme 时会自动 --without i18n）。
    ConflictRule {
        subject_id: CODEX_THEME_ID,
        peer_id: CONTEXT_VIEWER_ID,
        level: ConflictLevel::Overlap,
        reason_code: "codex_skip_i18n_with_viewer",
        reason: "已检测到 antigravity-context-viewer，安装时会自动跳过重复汉化模块，仅保留主题与底栏用量条。",
    },
    ConflictRule {
        subject_id: CONTEXT_VIEWER_ID,
        peer_id: CODEX_THEME_ID,
        level: ConflictLevel::Overlap,
        reason_code: "viewer_with_codex_i18n",
        reason: "两者均内置界面汉化与用量监控；并存时建议仅在其中一款开启汉化，避免文案重复替换。",
    },
    // 4. context-viewer ↔ chuanban：汉化与 Token 统计重叠。
    ConflictRule {
        subject_id: CONTEXT_VIEWER_ID,
        peer_id: CHUANBAN_THEME_ID,
        level: ConflictLevel::Overlap,
        reason_code: "viewer_chuanban_i18n_stats",
        reason: "两者均含中文界面汉化与 Token 统计面板；并存时建议仅在一处开启汉化。",
    },
    ConflictRule {
        subject_id: CHUANBAN_THEME_ID,
        peer_id: CONTEXT_VIEWER_ID,
        level: ConflictLevel::Overlap,
        reason_code: "viewer_chuanban_i18n_stats",
        reason: "两者均含中文界面汉化与 Token 统计面板；并存时建议仅在一处开启汉化。",
    },
    // 5. usage-monitor ↔ 两款 CDP 主题：Shadow DOM 胶囊可共用调试通道并存，仅提示用量条与宿主翻译勿重复开启。
    ConflictRule {
        subject_id: USAGE_MONITOR_ID,
        peer_id: CODEX_THEME_ID,
        level: ConflictLevel::Overlap,
        reason_code: "monitor_theme_coexist",
        reason: "可共用调试通道并存；两者均含用量监控，如启用 usage-monitor 宿主翻译请关闭主题汉化。",
    },
    ConflictRule {
        subject_id: CODEX_THEME_ID,
        peer_id: USAGE_MONITOR_ID,
        level: ConflictLevel::Overlap,
        reason_code: "monitor_theme_coexist",
        reason: "可共用调试通道并存；两者均含用量监控，如启用 usage-monitor 宿主翻译请关闭主题汉化。",
    },
    ConflictRule {
        subject_id: USAGE_MONITOR_ID,
        peer_id: CHUANBAN_THEME_ID,
        level: ConflictLevel::Overlap,
        reason_code: "monitor_theme_coexist",
        reason: "可共用调试通道并存；两者均含用量监控，如启用 usage-monitor 宿主翻译请关闭主题汉化。",
    },
    ConflictRule {
        subject_id: CHUANBAN_THEME_ID,
        peer_id: USAGE_MONITOR_ID,
        level: ConflictLevel::Overlap,
        reason_code: "monitor_theme_coexist",
        reason: "可共用调试通道并存；两者均含用量监控，如启用 usage-monitor 宿主翻译请关闭主题汉化。",
    },
];

/// 返回指定插件的所有硬互斥对端 ID（用于自动卸载互斥旧插件与兼容字段 `conflictsWith`）。
pub(crate) fn exclusive_peer_ids(id: &str) -> Vec<String> {
    CONFLICT_RULES
        .iter()
        .filter(|r| r.subject_id == id && r.level == ConflictLevel::Exclusive)
        .map(|r| r.peer_id.to_string())
        .collect()
}

/// 返回指定插件的全部冲突/重叠关系声明（不含运行时安装态，由 `apply_conflict_matrix` 注入 `active`）。
pub(crate) fn conflict_entries_for(
    id: &str,
    is_installed: impl Fn(&str) -> bool,
) -> Vec<EnhanceConflict> {
    CONFLICT_RULES
        .iter()
        .filter(|r| r.subject_id == id)
        .map(|r| EnhanceConflict {
            peer_id: r.peer_id.to_string(),
            level: r.level,
            reason_code: r.reason_code.to_string(),
            reason: r.reason.to_string(),
            active: is_installed(r.peer_id),
        })
        .collect()
}

/// 按当前各增强项的真实安装状态，统一回填 `conflicts_with` 与 `conflicts`（单一真源入口）。
pub(crate) fn apply_conflict_matrix(items: &mut [EnhanceItemStatus]) {
    let installed_ids: Vec<String> = items
        .iter()
        .filter(|it| it.installed)
        .map(|it| it.id.clone())
        .collect();
    let is_installed = |peer: &str| installed_ids.iter().any(|x| x == peer);

    for item in items.iter_mut() {
        item.conflicts_with = exclusive_peer_ids(&item.id);
        item.conflicts = conflict_entries_for(&item.id, is_installed);
    }
}

#[cfg(test)]
pub(crate) fn all_conflict_pairs_for_test() -> Vec<(&'static str, &'static str, ConflictLevel)> {
    CONFLICT_RULES
        .iter()
        .map(|r| (r.subject_id, r.peer_id, r.level))
        .collect()
}
