use std::path::PathBuf;
use super::{AgentSpec, Family, FileSource, PathSource, SelfUpdate};
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
        self_update: None,
        gui_exe_prefix: None,
        latest_channel: None,
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
        self_update: None,
        gui_exe_prefix: None,
        latest_channel: None,
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
        self_update: None,
        gui_exe_prefix: None,
        latest_channel: None,
    },
    AgentSpec {
        id: "antigravity",
        name: "Antigravity",
        vendor: "Google",
        api_format: "gemini",
        family: Family::Custom,
        config_dir: PathSource::Resolver(crate::commands::platforms::antigravity_hub_config_dir),
        config_file: FileSource::Name("settings.json"),
        bin: None,
        npm_package: None,
        official_url: Some("https://antigravity.google/download"),
        inject: None,
        self_update: None,
        gui_exe_prefix: None,
        latest_channel: None,
    },
    AgentSpec {
        id: "antigravity-ide",
        name: "Antigravity IDE",
        vendor: "Google",
        api_format: "gemini",
        family: Family::Custom,
        config_dir: PathSource::Resolver(crate::commands::platforms::antigravity_ide_config_dir),
        config_file: FileSource::Name("settings.json"),
        bin: None,
        npm_package: None,
        official_url: Some("https://antigravity.google/download"),
        inject: None,
        self_update: None,
        gui_exe_prefix: None,
        latest_channel: None,
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
        // 官方自更新：实测 `claude update` 存在，且会按自己的安装方式更新
        // （native 安装器 / package manager）。必须优先于 npm —— 本机同时
        // 存在 ~/.local/bin/claude.exe（PATH 优先）与 npm 全局版，只跑 npm
        // 升级的是另一份，验证会一直读到旧版本号。
        self_update: Some(SelfUpdate {
            subcommand: &["update"],
            env: None,
        }),
        gui_exe_prefix: None,
        latest_channel: None,
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
        self_update: None,
        gui_exe_prefix: None,
        latest_channel: None,
    },
    AgentSpec {
        id: "codex",
        name: "Codex",
        vendor: "OpenAI",
        api_format: "openai",
        family: Family::TomlConfig,
        config_dir: PathSource::Resolver(crate::commands::platforms::codex_home),
        config_file: FileSource::Name("config.toml"),
        bin: Some("codex"),
        npm_package: Some("@openai/codex"),
        official_url: Some("https://github.com/openai/codex"),
        inject: None,
        self_update: Some(SelfUpdate { subcommand: &["update"], env: None }),
        gui_exe_prefix: None,
        latest_channel: None,
    },
    AgentSpec {
        id: "codebuddy",
        name: "CodeBuddy",
        vendor: "Tencent Cloud",
        api_format: "openai",
        family: Family::JsonConfig,
        config_dir: PathSource::Template("~/.codebuddy"),
        config_file: FileSource::Name("models.json"),
        // 桌面 IDE（非 CLI）：不加 bin，避免读到同名 CLI 的版本
        bin: None,
        npm_package: None,
        official_url: Some("https://copilot.tencent.com"),
        inject: None,
        self_update: None,
        gui_exe_prefix: Some("codebuddy"),
        latest_channel: None,
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
        // 无 npm 包：@vibe-kit/grok-cli 是第三方包（0.0.34），
        // 与本机 xAI 官方 grok CLI（1.0.30，~/.grok/bin）不是一个产品
        npm_package: None,
        official_url: Some("https://x.ai/cli"),
        inject: None,
        // 官方 grok update（实测 --help 有 "update  Check for updates or
        // install a specific version"）；npm 无官方包，不能走 npm。
        // 必须显式 GROK_INSTALLER=internal：缺省时 grok 把自装误判为 npm
        // （--check --json 自报 installer=npm、error="program not found"），
        // Windows 上 spawn npm（只有 npm.cmd）必失败；设为 internal 后
        // --check 返回 error=null、update 返回 "Already up to date"。
        self_update: Some(SelfUpdate {
            subcommand: &["update"],
            env: Some(&[("GROK_INSTALLER", "internal")]),
        }),
        gui_exe_prefix: None,
        // 官方版本通道（magpie 同思路）：x.ai 优先，GCS 为备份
        // 实测本机 1.0.30，官方 stable 通道为 1.0.70
        latest_channel: Some(&[
            "https://x.ai/cli/stable",
            "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable",
        ]),
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
        self_update: None,
        gui_exe_prefix: None,
        latest_channel: None,
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
        self_update: None,
        gui_exe_prefix: None,
        latest_channel: None,
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
        self_update: None,
        gui_exe_prefix: None,
        latest_channel: None,
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
        self_update: Some(SelfUpdate { subcommand: &["update", "self"], env: None }),
        gui_exe_prefix: None,
        latest_channel: None,
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
        self_update: Some(SelfUpdate { subcommand: &["update"], env: None }),
        gui_exe_prefix: None,
        latest_channel: None,
    },
    // ── 新增 agent 的写法（示例，默认不注册）──
    //
    // 需要一个新 agent 时：
    //   1. node scripts/new-agent.mjs <id>   → 打印模板
    //   2. 取消下面注释、按实际值填写（尤其 inject：决定怎么写入配置）
    //   3. npm run check:features            → 机器校验字段完整性
    //
    // 示例（Gemini CLI，字段来自 magpie 实测）：
    //
    // AgentSpec {
    //     id: "gemini-cli",
    //     name: "Gemini CLI",
    //     vendor: "Google",
    //     api_format: "openai",
    //     family: Family::JsonConfig,
    //     config_dir: PathSource::Template("~/.gemini"),
    //     config_file: FileSource::Name("settings.json"),
    //     bin: Some("gemini"),
    //     npm_package: Some("@google/gemini-cli"),
    //     official_url: Some("https://github.com/google-gemini/gemini-cli"),
    //     inject: Some(InjectSpec {
    //         endpoint: Some(InjectTarget::Env { key: "GOOGLE_GEMINI_BASE_URL" }),
    //         api_key: Some(InjectTarget::Env { key: "GEMINI_API_KEY" }),
    //         model: Some(InjectTarget::Json { pointer: "/model/name" }),
    //         env_file: ".env",
    //     }),
    // },
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
        self_update: None,
        gui_exe_prefix: None,
        latest_channel: None,
    },
];

/// MITM 族的配置目录 = VS Code settings.json 所在目录。
/// 复用 ide_config::settings_path（一键注入的同款定位），不另造路径规则。
fn ide_settings_dir(target: &str) -> Option<PathBuf> {
    crate::commands::ide_config::settings_path(target).and_then(|p| p.parent().map(|d| d.to_path_buf()))
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
    crate::commands::claude_desktop::current_platform_paths()
        .ok()
        .map(|p| p.threep_dir)
}

fn claude_desktop_config_path() -> Option<PathBuf> {
    crate::commands::claude_desktop::current_platform_paths()
        .ok()
        .map(|p| p.threep_config_path)
}

fn hermes_dir() -> Option<PathBuf> {
    crate::commands::platforms::hermes_config_dir()
}

fn deepseek_dir() -> Option<PathBuf> {
    crate::commands::platforms::deepseek_harness_home()
}
