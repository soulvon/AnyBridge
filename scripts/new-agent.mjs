#!/usr/bin/env node
// 新增 agent 脚手架：node scripts/new-agent.mjs <id>
//
// 目标：社区 PR 只需回答几个问题，产出可直接粘贴的 AgentSpec 声明。
// 不自动改文件（避免误伤），只打印模板 + 注册位置 + 校验命令。

const id = process.argv[2];
if (!id) {
  console.error('用法: node scripts/new-agent.mjs <id>   （id 用 kebab-case，如 gemini-cli）');
  process.exit(1);
}
if (!/^[a-z0-9-]+$/.test(id)) {
  console.error('id 必须是 kebab-case（小写字母/数字/连字符）');
  process.exit(1);
}

const title = id
  .split('-')
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  .join(' ');

console.log(`
// ─────────────────────────────────────────────────────────────
// 把下面这段加到 src-tauri/src/commands/agent_spec.rs 的 AGENTS 表
// （挑一个同族的条目照抄最省事：JsonConfig / TomlConfig / YamlConfig）
// ─────────────────────────────────────────────────────────────

    AgentSpec {
        id: "${id}",
        name: "${title}",                    // TODO 展示名，如 "Gemini CLI"
        vendor: "TODO",                      // TODO 厂商，如 "Google"
        api_format: "openai",                // openai | anthropic
        family: Family::JsonConfig,          // 协议族（决定复用哪套注入实现）
        config_dir: PathSource::Template("~/.${id}"),   // TODO 配置目录
        config_file: FileSource::Name("settings.json"), // TODO 配置文件名
        bin: Some("${id}"),                  // TODO CLI 命令名；无 CLI 填 None
        npm_package: Some("@scope/${id}"),   // TODO npm 包名；非 npm 安装填 None
        official_url: Some("https://TODO"),  // TODO 官方地址；没有填 None
    },

// ─────────────────────────────────────────────────────────────
// 自查清单（跑 npm run check:features 会逐项机器校验）
//   [ ] id 唯一且 kebab-case
//   [ ] config_dir 能解析（~/ 或绝对路径；Custom 族必须用 PathSource::Resolver）
//   [ ] config_file 与真实文件名一致（json/jsonc 双候选用 FileSource::Candidates）
//   [ ] bin / npm_package 与实际安装方式一致（不确定就填 None —— 读失败=未知，不猜）
//   [ ] 若需要专属页面区块，先在 docs 里说明 capabilities，再改前端模板
// ─────────────────────────────────────────────────────────────
`);
