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

    /// 安装证据三选一（借鉴 magpie `Detected()`）：
    /// 配置目录存在 / 配置文件存在 / CLI 可执行文件命中。
    pub fn detect_installed(&self) -> bool {
        if self
            .resolve_config_dir()
            .map(|d| d.exists())
            .unwrap_or(false)
        {
            return true;
        }
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
    },
];

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

/// 供前端/日志使用的摘要（未来动态页面渲染的数据源）。
#[derive(Serialize)]
pub struct AgentSummary {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub family: String,
    pub has_cli: bool,
    pub npm_package: Option<String>,
    pub official_url: Option<String>,
}

pub fn list_summaries() -> Vec<AgentSummary> {
    AGENTS
        .iter()
        .map(|s| AgentSummary {
            id: s.id.to_string(),
            name: s.name.to_string(),
            vendor: s.vendor.to_string(),
            family: s.family.as_str().to_string(),
            has_cli: s.bin.is_some(),
            npm_package: s.npm_package.map(|p| p.to_string()),
            official_url: s.official_url.map(|u| u.to_string()),
        })
        .collect()
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
