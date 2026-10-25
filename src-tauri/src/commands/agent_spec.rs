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
    /// 代理接管（Windsurf / Devin / Cursor）：起 MITM + 改 settings
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

/// 注入落点：一条声明的某个值写到哪。
#[derive(Clone, Copy, Debug)]
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

/// 平台元数据的唯一真源。
pub static AGENTS: &[AgentSpec] = &[
    // ── MITM 代理族：接入走 ide_proxy（起代理 + 改 settings），
    //    这里统一的是「元数据 / 探测 / 版本」口径 —— family = MitmProxy。
    //    inject 为 None：写入逻辑由 ide_proxy 负责，不走声明式单字段注入。
    AgentSpec {
        id: "windsurf",
        name: "Windsurf",
        vendor: "Codeium",
        api_format: "openai",
        family: Family::MitmProxy,
        config_dir: PathSource::Resolver(windsurf_settings_dir),
        config_file: FileSource::Name("settings.json"),
        bin: None,
        npm_package: None,
        official_url: Some("https://windsurf.com/download"),
        inject: None,
    },
    AgentSpec {
        id: "devin",
        name: "Devin",
        vendor: "Codeium",
        api_format: "openai",
        family: Family::MitmProxy,
        config_dir: PathSource::Resolver(devin_settings_dir),
        config_file: FileSource::Name("settings.json"),
        bin: None,
        npm_package: None,
        official_url: Some("https://devin.ai"),
        inject: None,
    },
    AgentSpec {
        id: "cursor",
        name: "Cursor",
        vendor: "Anysphere",
        api_format: "openai",
        family: Family::MitmProxy,
        config_dir: PathSource::Resolver(cursor_settings_dir),
        config_file: FileSource::Name("settings.json"),
        bin: None,
        npm_package: None,
        official_url: Some("https://cursor.com/downloads"),
        inject: None,
    },
    AgentSpec {
        id: "antigravity",
        name: "Antigravity",
        vendor: "Google",
        api_format: "openai",
        family: Family::Custom,
        config_dir: PathSource::Resolver(super::platforms::antigravity_hub_config_dir),
        config_file: FileSource::Name("settings.json"),
        bin: None,
        npm_package: None,
        official_url: Some("https://antigravity.google/download"),
        inject: None,
    },
    AgentSpec {
        id: "antigravity-ide",
        name: "Antigravity IDE",
        vendor: "Google",
        api_format: "openai",
        family: Family::Custom,
        config_dir: PathSource::Resolver(super::platforms::antigravity_ide_config_dir),
        config_file: FileSource::Name("settings.json"),
        bin: None,
        npm_package: None,
        official_url: Some("https://antigravity.google/download"),
        inject: None,
    },
    AgentSpec {
        id: "claude-code",
        name: "Claude Code",
        vendor: "Anthropic",
        api_format: "anthropic",
        family: Family::JsonConfig,
        config_dir: PathSource::Template("~/.claude"),
        config_file: FileSource::Name("settings.json"),
        bin: Some("claude"),
        npm_package: Some("@anthropic-ai/claude-code"),
        official_url: Some("https://docs.anthropic.com/en/docs/claude-code"),
        inject: None,
    },
    AgentSpec {
        id: "claude-desktop",
        name: "Claude Desktop",
        vendor: "Anthropic",
        api_format: "anthropic",
        family: Family::Custom,
        config_dir: PathSource::Resolver(claude_desktop_config_dir),
        config_file: FileSource::Resolver(claude_desktop_config_path),
        bin: None,
        npm_package: None,
        official_url: Some("https://claude.com/download"),
        inject: None,
    },
    AgentSpec {
        id: "codex",
        name: "Codex",
        vendor: "OpenAI",
        api_format: "openai",
        family: Family::TomlConfig,
        config_dir: PathSource::Resolver(super::platforms::codex_home),
        config_file: FileSource::Name("config.toml"),
        bin: Some("codex"),
        npm_package: Some("@openai/codex"),
        official_url: Some("https://github.com/openai/codex"),
        inject: None,
    },
    AgentSpec {
        id: "codebuddy",
        name: "CodeBuddy",
        vendor: "Tencent Cloud",
        api_format: "openai",
        family: Family::JsonConfig,
        config_dir: PathSource::Template("~/.codebuddy"),
        config_file: FileSource::Name("models.json"),
        bin: Some("codebuddy"),
        npm_package: Some("@tencent-ai/codebuddy-code"),
        official_url: Some("https://copilot.tencent.com"),
        inject: None,
    },
    AgentSpec {
        id: "grok",
        name: "Grok",
        vendor: "xAI",
        api_format: "openai",
        family: Family::TomlConfig,
        config_dir: PathSource::Template("~/.grok"),
        config_file: FileSource::Name("config.toml"),
        bin: Some("grok"),
        npm_package: Some("@vibe-kit/grok-cli"),
        official_url: Some("https://x.ai/cli"),
        inject: None,
    },
    AgentSpec {
        id: "opencode",
        name: "OpenCode",
        vendor: "OpenCode",
        api_format: "openai",
        family: Family::JsonConfig,
        config_dir: PathSource::Template("~/.config/opencode"),
        config_file: FileSource::Candidates(&["opencode.json", "opencode.jsonc"]),
        bin: Some("opencode"),
        npm_package: Some("opencode-ai"),
        official_url: Some("https://opencode.ai"),
        inject: None,
    },
    AgentSpec {
        id: "workbuddy",
        name: "WorkBuddy",
        vendor: "Tencent Cloud",
        api_format: "openai",
        family: Family::JsonConfig,
        config_dir: PathSource::Template("~/.workbuddy"),
        config_file: FileSource::Name("models.json"),
        bin: None,
        npm_package: None,
        official_url: None,
        inject: None,
    },
    AgentSpec {
        id: "zcode",
        name: "ZCode",
        vendor: "Z.AI",
        api_format: "openai",
        family: Family::JsonConfig,
        config_dir: PathSource::Template("~/.zcode"),
        config_file: FileSource::SubPath("v2/config.json"),
        bin: None,
        npm_package: None,
        official_url: None,
        inject: None,
    },
    AgentSpec {
        id: "pi",
        name: "Pi",
        vendor: "Earendil Works",
        api_format: "openai",
        family: Family::JsonConfig,
        config_dir: PathSource::Template("~/.pi/agent"),
        config_file: FileSource::Name("models.json"),
        bin: Some("pi"),
        npm_package: Some("@earendil-works/pi-coding-agent"),
        official_url: None,
        inject: None,
    },
    AgentSpec {
        id: "hermes",
        name: "Hermes",
        vendor: "Nous Research",
        api_format: "openai",
        family: Family::YamlConfig,
        config_dir: PathSource::Resolver(hermes_dir),
        config_file: FileSource::Name("config.yaml"),
        bin: Some("hermes"),
        npm_package: None,
        official_url: None,
        inject: None,
    },
    // ── 声明式扩展的第一个实例：新增 agent 只需下面这一个条目 ──
    AgentSpec {
        id: "gemini-cli",
        name: "Gemini CLI",
        vendor: "Google",
        api_format: "openai",
        family: Family::JsonConfig,
        // 注意：~/.gemini 也会被 Antigravity 占用，所以证据以
        // settings.json 与 gemini 可执行为准（detect_installed 文件优先）
        config_dir: PathSource::Template("~/.gemini"),
        config_file: FileSource::Name("settings.json"),
        bin: Some("gemini"),
        npm_package: Some("@google/gemini-cli"),
        official_url: Some("https://github.com/google-gemini/gemini-cli"),
        // 接入方式（magpie 实测）：端点与密钥写 ~/.gemini/.env，
        // 模型名写 settings.json 的 model.name
        inject: Some(InjectSpec {
            endpoint: Some(InjectTarget::Env {
                key: "GOOGLE_GEMINI_BASE_URL",
            }),
            api_key: Some(InjectTarget::Env {
                key: "GEMINI_API_KEY",
            }),
            model: Some(InjectTarget::Json {
                pointer: "/model/name",
            }),
            env_file: ".env",
        }),
    },
    AgentSpec {
        id: "deepseek-harness",
        name: "DeepSeek Harness",
        vendor: "DeepSeek",
        api_format: "openai",
        family: Family::YamlConfig,
        config_dir: PathSource::Resolver(deepseek_dir),
        config_file: FileSource::Name("settings.yaml"),
        bin: Some("dsh"),
        npm_package: Some("@deepseek-ai/dsh"),
        official_url: None,
        inject: None,
    },
];

/// MITM 族的配置目录 = VS Code settings.json 所在目录。
/// 复用 ide_config::settings_path（一键注入的同款定位），不另造路径规则。
fn ide_settings_dir(target: &str) -> Option<PathBuf> {
    super::ide_config::settings_path(target).and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

fn windsurf_settings_dir() -> Option<PathBuf> {
    ide_settings_dir("windsurf")
}

fn devin_settings_dir() -> Option<PathBuf> {
    ide_settings_dir("devin")
}

fn cursor_settings_dir() -> Option<PathBuf> {
    ide_settings_dir("cursor")
}

fn claude_desktop_config_dir() -> Option<PathBuf> {
    super::claude_desktop::current_platform_paths()
        .ok()
        .map(|p| p.threep_dir)
}

fn claude_desktop_config_path() -> Option<PathBuf> {
    super::claude_desktop::current_platform_paths()
        .ok()
        .map(|p| p.threep_config_path)
}

fn hermes_dir() -> Option<PathBuf> {
    super::platforms::hermes_config_dir()
}

fn deepseek_dir() -> Option<PathBuf> {
    super::platforms::deepseek_harness_home()
}

/// 按 id 查 spec（O(n)，n=13，无需索引）。
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
mod tests {
    use super::*;

    /// 路径模板解析
    #[test]
    fn resolves_home_template() {
        let p = resolve_path_template("~/.fake-agent").expect("应可解析");
        assert!(p.is_absolute());
        assert!(p.ends_with(".fake-agent"));
    }

    /// 不可解析的模板返回 None（不猜路径）
    #[test]
    fn rejects_unresolvable_template() {
        assert!(resolve_path_template("relative/path").is_none());
        assert!(resolve_path_template("%__ANYBRIDGE_NOT_SET__%/x").is_none());
    }

    /// 本机诊断：打印注册表（cargo test --lib debug_registry -- --ignored --nocapture）
    #[test]
    #[ignore]
    fn debug_registry() {
        for e in list_registry() {
            println!(
                "{} | {} | installed={} | has_page={} | {}",
                e.id, e.name, e.installed, e.has_page, e.config_path
            );
        }
    }

    /// 注册表必须合法（社区 PR 的第一道门）
    #[test]
    fn registry_is_valid() {
        validate_registry().expect("注册表应通过校验");
    }

    /// 13 个内置平台全部在表中（元数据单一真源的完整性）
    #[test]
    fn all_builtin_platforms_registered() {
        for id in [
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
        ] {
            assert!(find(id).is_some(), "缺少内置平台声明: {id}");
        }
    }

    /// 元数据快照：13 个平台的关键字段**硬编码期望值**。
    /// 迁移后 Platform 读表，两边同源会自证——所以这里用独立快照，
    /// 防止有人误改声明（改错立刻红）。
    #[test]
    fn metadata_snapshot() {
        let expected: &[(&str, &str, &str, &str, &str, Option<&str>, Option<&str>)] = &[
            ("windsurf", "Windsurf", "Codeium", "openai", "settings.json", None, None),
            ("devin", "Devin", "Codeium", "openai", "settings.json", None, None),
            ("cursor", "Cursor", "Anysphere", "openai", "settings.json", None, None),
            ("antigravity", "Antigravity", "Google", "openai", "settings.json", None, None),
            ("antigravity-ide", "Antigravity IDE", "Google", "openai", "settings.json", None, None),
            ("claude-code", "Claude Code", "Anthropic", "anthropic", "settings.json", Some("claude"), Some("@anthropic-ai/claude-code")),
            ("claude-desktop", "Claude Desktop", "Anthropic", "anthropic", "", None, None),
            ("codex", "Codex", "OpenAI", "openai", "config.toml", Some("codex"), Some("@openai/codex")),
            ("codebuddy", "CodeBuddy", "Tencent Cloud", "openai", "models.json", Some("codebuddy"), Some("@tencent-ai/codebuddy-code")),
            ("grok", "Grok", "xAI", "openai", "config.toml", Some("grok"), Some("@vibe-kit/grok-cli")),
            ("opencode", "OpenCode", "OpenCode", "openai", "opencode.json", Some("opencode"), Some("opencode-ai")),
            ("workbuddy", "WorkBuddy", "Tencent Cloud", "openai", "models.json", None, None),
            ("zcode", "ZCode", "Z.AI", "openai", "config.json", None, None),
            ("pi", "Pi", "Earendil Works", "openai", "models.json", Some("pi"), Some("@earendil-works/pi-coding-agent")),
            ("hermes", "Hermes", "Nous Research", "openai", "config.yaml", Some("hermes"), None),
            ("deepseek-harness", "DeepSeek Harness", "DeepSeek", "openai", "settings.yaml", Some("dsh"), Some("@deepseek-ai/dsh")),
        ];
        for (id, name, vendor, api, file_tail, bin, npm) in expected.iter().copied() {
            let spec = find(id).unwrap_or_else(|| panic!("缺少声明: {id}"));
            assert_eq!(spec.name, name, "{id} 名称被改动");
            assert_eq!(spec.vendor, vendor, "{id} 厂商被改动");
            assert_eq!(spec.api_format, api, "{id} API 格式被改动");
            assert_eq!(spec.bin, bin, "{id} CLI 命令名被改动");
            assert_eq!(spec.npm_package, npm, "{id} npm 包名被改动");
            if !file_tail.is_empty() {
                let path = spec.resolve_config_path().expect("配置路径应可解析");
                let shown = path.to_string_lossy();
                assert!(
                    shown.ends_with(file_tail),
                    "{id} 配置文件应为 {file_tail}，实际 {shown}"
                );
            }
        }
    }


}
