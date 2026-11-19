//! Agent 声明式注册表 —— **平台元数据的唯一真源**。
//!
//! 设计目标（长期可维护）：
//! 1. **新增 agent = 一个 spec 条目**（标准型）；特殊型用 `PathSource::Resolver`
//!    复用既有定位函数，不需要写第二个探测体系。
//! 2. **元数据集中**：id / 名称 / 厂商 / API 格式 / 配置路径 / CLI bin / npm 包 /
//!    官方地址 全在这张表里，不再散落在 enum 的 6 个 match 分支中。
//! 3. **行为等价迁移**：`Platform` 的方法改为读表，逐平台对比测试保证一致；
//!    迁移完成后 enum 只剩 apply/restore 的分发职责（后续批次继续收敛）。
//!
//! 为什么不做运行时热插拔：声明在编译期注册，漏填字段编译不过；社区 PR 本来
//! 就要走编译与发版，换成运行时加载只多三份复杂度（schema 版本、失败隔离、
//! 安全边界），没有收益。

use serde::Serialize;
use std::path::PathBuf;

/// 接入协议族——决定复用哪套注入/探测实现。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Family {
    /// JSON 配置注入（Claude Code / CodeBuddy / OpenCode / Pi / Antigravity）
    JsonConfig,
    /// TOML 配置注入（Codex / Grok）
    TomlConfig,
    /// YAML 配置注入（Hermes / DeepSeek Harness）
    YamlConfig,
    /// 网关接管（Windsurf / Devin / Cursor）：起 MITM + 改 settings
    MitmProxy,
    /// Electron 特殊形态（Antigravity asar 补丁 / Claude Desktop 角色档位）
    Custom,
}

impl Family {
    pub fn as_str(self) -> &'static str {
        match self {
            Family::JsonConfig => "json-config",
            Family::TomlConfig => "toml-config",
            Family::YamlConfig => "yaml-config",
            Family::MitmProxy => "mitm-proxy",
            Family::Custom => "custom",
        }
    }
}

/// 配置目录来源。
///
/// 绝大多数平台是静态模板（`~/.xxx`）；少数依赖注册表/进程/平台判断
/// （Antigravity / Claude Desktop / Codex / Hermes / DeepSeek），复用既有
/// 定位函数——**不在 spec 里重写第二套探测**。
#[derive(Clone, Copy)]
pub enum PathSource {
    /// `~/x`、`%VAR%/x`、绝对路径，运行时展开
    Template(&'static str),
    /// 动态定位函数（毫秒级，带既有缓存）
    Resolver(fn() -> Option<PathBuf>),
}

impl std::fmt::Debug for PathSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathSource::Template(t) => write!(f, "Template({t})"),
            PathSource::Resolver(_) => write!(f, "Resolver(fn)"),
        }
    }
}

/// 配置文件名来源。
#[derive(Clone, Copy, Debug)]
pub enum FileSource {
    /// 目录下固定文件名
    Name(&'static str),
    /// 相对子路径 + 文件名（如 `v2/config.json`）
    SubPath(&'static str),
    /// 多候选：存在的优先，否则取第一个（OpenCode 的 json/jsonc）
    Candidates(&'static [&'static str]),
    /// 动态（Claude Desktop：路径由平台判断决定）
    Resolver(fn() -> Option<PathBuf>),
}

/// 官方自更新命令（如 Claude Code 的 `claude update`）。
///
/// 为什么优先于 npm：官方命令知道自己是 native 安装器还是包管理器装的，
/// 实测 claude 同时存在 `~/.local/bin/claude.exe`（官方版，PATH 优先）与
/// npm 全局版——只跑 npm install -g 升级的是另一份，验证时读到的仍是
/// 官方版旧版本号，于是误报「更新失败」。
#[derive(Clone, Copy, Debug)]
pub struct SelfUpdate {
    /// 子命令参数，如 ["update"]
    pub subcommand: &'static [&'static str],
    /// 官方命令需要的环境变量覆盖。
    ///
    /// grok 实测（2026-10-26）：不设 `GROK_INSTALLER` 时它把自装（~/.grok/bin）
    /// 误判为 npm 安装，走 npm 更新分支——Windows 上 npm 只有 npm.cmd，
    /// Rust CreateProcess 不解析 PATHEXT → 报 "program not found"，更新必失败。
    /// 显式 `GROK_INSTALLER=internal`（官方枚举 internal/npm/gh-release 之一）
    /// 后走自下载通道正常（实测 `--check --json` error=null、update 返回
    /// "Already up to date"）。
    pub env: Option<&'static [(&'static str, &'static str)]>,
}

/// 注入落点：一条声明的某个值写到哪。
///
/// 当前没有内置声明启用 inject（示例见 AGENTS 表里的注释），
/// 能力由「新增 agent」流程使用，故标 allow(dead_code)。
#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
pub enum InjectTarget {
    /// dotenv 文件的键（如 GOOGLE_GEMINI_BASE_URL）
    Env { key: &'static str },
    /// JSON 配置文件的 JSON Pointer（如 /model/name）
    Json { pointer: &'static str },
}

/// 接入方式声明：endpoint / api_key / model 各写到哪里。
///
/// 字段留 None = 该值无处可写（例如某些 CLI 只认环境变量）；
/// 全部 None 表示该 agent 暂不支持一键接入（诚实降级）。
#[derive(Clone, Copy, Debug)]
pub struct InjectSpec {
    pub endpoint: Option<InjectTarget>,
    pub api_key: Option<InjectTarget>,
    pub model: Option<InjectTarget>,
    /// dotenv 文件名（相对配置目录），默认 ".env"
    pub env_file: &'static str,
}

/// 一个 agent 的声明（社区 PR 只填这里）。
#[derive(Clone, Copy, Debug)]
pub struct AgentSpec {
    /// 平台 id（kebab-case，与 `Platform::id()` 一致）
    pub id: &'static str,
    /// 展示名
    pub name: &'static str,
    /// 厂商
    pub vendor: &'static str,
    /// 要求的 API 格式（openai / anthropic）
    pub api_format: &'static str,
    /// 协议族
    pub family: Family,
    /// 配置目录
    pub config_dir: PathSource,
    /// 配置文件名
    pub config_file: FileSource,
    /// CLI 可执行名（版本探测用；GUI 客户端为 None）
    pub bin: Option<&'static str>,
    /// npm 包名（更新检查用）
    pub npm_package: Option<&'static str>,
    /// 官方地址
    pub official_url: Option<&'static str>,
    /// 接入方式（None = 暂不支持一键接入）
    pub inject: Option<InjectSpec>,
    /// 官方版本指针（channel pointer）：一组 URL，响应体就是纯文本版本号。
    ///
    /// 用于「没有 npm 包、但官方提供版本通道」的平台（借鉴 magpie 的
    /// grokLatest）：实测 grok 官方 CLI 1.0.30 的最新版是 1.0.70，来自
    /// storage.googleapis.com/grok-build-public-artifacts/cli/stable，
    /// 而 npm 上没有官方包（@vibe-kit/grok-cli 是另一个产品）。
    pub latest_channel: Option<&'static [&'static str]>,
    /// 官方自更新命令（有则优先于 npm）
    pub self_update: Option<SelfUpdate>,
    /// 桌面 IDE 的进程名前缀（如 "codebuddy"）：版本从安装目录读，
    /// 而不是从同名 CLI 读——两者是不同产品
    /// （实测 CodeBuddy IDE 1.106.1 vs CLI 2.171.0）
    pub gui_exe_prefix: Option<&'static str>,
}

impl AgentSpec {
    /// 解析配置目录（绝对路径）。
    pub fn resolve_config_dir(&self) -> Option<PathBuf> {
        match self.config_dir {
            PathSource::Template(t) => resolve_path_template(t),
            PathSource::Resolver(f) => f(),
        }
    }

    /// 解析配置文件完整路径（统一分隔符，保证与旧实现逐字节相等）。
    pub fn resolve_config_path(&self) -> Option<PathBuf> {
        let dir = self.resolve_config_dir()?;
        let join = |rel: &str| -> PathBuf {
            let p = dir.join(rel);
            PathBuf::from(p.to_string_lossy().replace('/', std::path::MAIN_SEPARATOR_STR))
        };
        match self.config_file {
            FileSource::Name(name) => Some(join(name)),
            FileSource::SubPath(rel) => Some(join(rel)),
            FileSource::Candidates(list) => {
                for c in list {
                    let p = join(c);
                    if p.exists() {
                        return Some(p);
                    }
                }
                list.first().map(|c| join(c))
            }
            FileSource::Resolver(f) => f(),
        }
    }

    /// 安装证据（借鉴 magpie `Detected()`，但**文件优先**）：
    /// ① 配置文件存在 → 已安装
    /// ② CLI 可执行文件命中 → 已安装
    /// ③ 只有「无 config_file（目录型 GUI 客户端）」才用配置目录存在作证据
    ///
    /// 为什么文件优先：配置目录可能被多个工具共用（如 `~/.gemini` 同时是
    /// Antigravity 的目录），仅凭目录存在会把未安装的工具误判为已安装。
    pub fn detect_installed(&self) -> bool {
        if self
            .resolve_config_path()
            .map(|p| p.exists())
            .unwrap_or(false)
        {
            return true;
        }
        if let Some(bin) = self.bin {
            if super::version_probe::find_tool(bin).is_some() {
                return true;
            }
        }
        let dir_only = matches!(self.config_file, FileSource::Name(""));
        if dir_only
            && self
                .resolve_config_dir()
                .map(|d| d.exists())
                .unwrap_or(false)
        {
            return true;
        }
        false
    }
}

/// 展开 `~` 与环境变量，产出绝对路径；不可解析返回 None（读失败=未知，不猜）。
pub fn resolve_path_template(tpl: &str) -> Option<PathBuf> {
    let mut s = tpl.trim().to_string();
    if let Some(rest) = s.strip_prefix("~/") {
        let home = dirs::home_dir()?;
        s = home.join(rest).to_string_lossy().to_string();
    } else if s == "~" {
        return dirs::home_dir();
    }
    for (k, v) in std::env::vars() {
        s = s.replace(&format!("%{}%", k), &v);
        s = s.replace(&format!("${{{}}}", k), &v);
    }
    if s.contains('%') || s.contains('$') {
        return None;
    }
    // 统一分隔符：模板里习惯写 `/`，Windows 上要规范成 `\`，
    // 否则同一个路径会出现 "a\\b/c" 混用（影响相等比较与展示）
    let normalized = s.replace('/', std::path::MAIN_SEPARATOR_STR);
    let p = PathBuf::from(normalized);
    if p.is_absolute() {
        Some(p)
    } else {
        None
    }
}

// ─────────────────────────────────────────────────────────────
// 注册表：13 个内置平台 + 未来新增
//
// 新增「配置式 agent」的最小步骤：
//   1. 在下方加一条 AgentSpec（照抄最近的同族条目）
//   2. 跑 npm run check:agents —— 字段/路径/唯一性全部机器校验
//   3. （可选）若需要专属页面区块，在 capabilities 里声明
// ─────────────────────────────────────────────────────────────

mod specs;
pub use specs::AGENTS;

pub fn find(id: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|s| s.id == id)
}

/// 注册表校验（启动期 + 检查脚本共用）：
/// - id kebab-case、唯一
/// - 配置目录可解析（模板可展开 / resolver 可调用）
/// - 至少有一个探测源（config_file 非空或 bin 存在）
/// - family 与路径来源一致（Custom 平台必须用 Resolver，避免误抄模板）
pub fn validate_registry() -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for spec in AGENTS {
        if spec.id.is_empty() {
            return Err("agent id 不能为空".to_string());
        }
        if !spec
            .id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(format!("agent id 必须为 kebab-case: {}", spec.id));
        }
        if !seen.insert(spec.id) {
            return Err(format!("agent id 重复: {}", spec.id));
        }
        if let PathSource::Template(t) = spec.config_dir {
            if resolve_path_template(t).is_none() {
                return Err(format!("agent {} 的 config_dir 模板无法解析: {}", spec.id, t));
            }
        }
        if matches!(spec.family, Family::Custom) && matches!(spec.config_dir, PathSource::Template(_)) {
            return Err(format!(
                "agent {} 是 Custom 族但 config_dir 用了静态模板——特殊平台必须用 Resolver 复用既有定位函数",
                spec.id
            ));
        }
        if spec.bin.is_none() && matches!(spec.config_file, FileSource::Name("")) {
            return Err(format!("agent {} 既无 bin 也无 config_file，无法探测", spec.id));
        }
    }
    Ok(())
}

/// 前端 rail / 通用页的数据源：声明表 + 实时探测结果（只读）。
#[derive(Serialize)]
pub struct AgentRegistryEntry {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub api_format: String,
    pub family: String,
    pub has_cli: bool,
    pub npm_package: Option<String>,
    pub official_url: Option<String>,
    /// 安装证据（配置目录/配置/CLI 任一命中）
    pub installed: bool,
    /// 解析后的配置目录（展示用，解析失败为空串）
    pub config_dir: String,
    /// 解析后的配置文件路径（展示用）
    pub config_path: String,
    /// 是否已有内置页面（false = 前端用通用页渲染）
    pub has_page: bool,
    /// 图标文件名约定：`platform-<id>.svg`（前端找不到图时回退首字母）
    pub icon: String,
    /// 配置里已写入的模型值（未接入/不支持时为 None）
    pub current_model: Option<String>,
}

/// 已有内置页面的 agent（与 ui-src/partials/pages 对应）。
/// 新增 agent 未列在这里 → 前端自动用通用页。
const BUILTIN_PAGES: &[&str] = &[
    // MITM 三平台：Windsurf/Devin 共用 models.html，Cursor 用 platform-cursor.html
    "windsurf",
    "devin",
    "cursor",
    "antigravity",
    "antigravity-ide",
    "claude-code",
    "claude-desktop",
    "codex",
    "codebuddy",
    "grok",
    "opencode",
    "workbuddy",
    "zcode",
    "pi",
    "hermes",
    "deepseek-harness",
];

pub fn list_registry() -> Vec<AgentRegistryEntry> {
    AGENTS
        .iter()
        .map(|s| {
            let config_dir = s
                .resolve_config_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let config_path = s
                .resolve_config_path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let installed = s.detect_installed();
            AgentRegistryEntry {
                id: s.id.to_string(),
                name: s.name.to_string(),
                vendor: s.vendor.to_string(),
                api_format: s.api_format.to_string(),
                family: s.family.as_str().to_string(),
                has_cli: s.bin.is_some(),
                npm_package: s.npm_package.map(|p| p.to_string()),
                official_url: s.official_url.map(|u| u.to_string()),
                installed,
                config_dir,
                config_path,
                has_page: BUILTIN_PAGES.contains(&s.id),
                icon: format!("platform-{}.svg", s.id),
                current_model: read_declared_model(s.id),
            }
        })
        .collect()
}

/// 读当前配置里**已写入的模型值**（inject.model 的目标位置）。
///
/// 用于通用页回显「当前模型」——避免用户不知道接入时写进了什么。
pub fn read_declared_model(platform_id: &str) -> Option<String> {
    let spec = find(platform_id)?;
    let inject = spec.inject?;
    match inject.model? {
        InjectTarget::Env { key } => {
            let dir = spec.resolve_config_dir()?;
            let content = std::fs::read_to_string(dir.join(inject.env_file)).ok()?;
            super::declared_apply::get_env(&content, key)
        }
        InjectTarget::Json { pointer } => {
            let path = spec.resolve_config_path()?;
            let content = std::fs::read_to_string(path).ok()?;
            let v: serde_json::Value = serde_json::from_str(&content).ok()?;
            let mut cur = &v;
            for seg in pointer
                .trim_start_matches('/')
                .split('/')
                .filter(|s| !s.is_empty())
            {
                cur = cur.get(seg)?;
            }
            cur.as_str().map(|s| s.to_string())
        }
    }
}

/// 只读配置内容（spec-only 平台用；内置平台仍走各自的读取逻辑）。
pub fn read_declared_config(platform_id: &str) -> Result<String, String> {
    let spec = find(platform_id).ok_or_else(|| format!("未声明的 agent: {platform_id}"))?;
    let path = spec
        .resolve_config_path()
        .ok_or_else(|| "无法解析配置文件路径".to_string())?;
    std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 {} 失败: {e}", path.to_string_lossy()))
}

// ─── Tauri 命令（前端 rail / 通用页） ───

#[tauri::command]
pub fn get_agent_registry() -> Vec<AgentRegistryEntry> {
    list_registry()
}

/// 只读配置文件内容（通用页「查看配置」用）。
#[tauri::command]
pub fn read_agent_config_file(platform: String) -> Result<String, String> {
    read_declared_config(&platform)
}

#[cfg(test)]
mod tests;
