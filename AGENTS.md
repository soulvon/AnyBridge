# AnyBridge — AI 开发约定（入口）

<!-- experience:begin -->
## 通用开发经验（自动注入，勿手改本段）

- 中央库：`C:\Users\admin\Desktop\devloop`
- 开工先读 `机器索引/索引.md`；写新逻辑前查能力清单，并复述复用了什么。
- 修改已知事故区域时，提交信息必须写 `已核对: <编号>`；不适用则写 `豁免: <原因>`。
- 新增经验：复制 `toolkit/templates/事故记录.md`，运行 `node toolkit/build.mjs`。
<!-- experience:end -->

> 任何 AI 工具进本仓库，先读完这一页，再动手。
> 详细内容在 `docs/`，此处只放**入口与强制项**，避免多处重复导致漂移。

## 0. 动手前必做

| 顺序 | 动作 |
|---|---|
| 1 | 读 `docs/pitfalls.json` —— **坑点库**（真实事故、Guard 与行为测试索引） |
| 2 | 读 `docs/capabilities.md` —— **核心能力与唯一实现清单**（严禁另起炉灶重复实现） |
| 3 | 读 `docs/WORKFLOW.md` —— 开发工作流（影响面、红绿测试、统一验证） |
| 4 | 跨模块改动先读 `docs/subsystems/README.md` 中对应的运行契约 |
| 5 | **强制寻宝与复述**：写新函数/新逻辑前必须先检索现有库。回复时必须显式陈述：“本次复用/扩展了现有能力 X（或经检索关键词 Y/Z 确认无先例）”，严禁无脑另写新轮子 |
| 6 | 确认本次改动触及的坑点、对称路径和旧配置兼容要求 |

## 1. 改完必做（强制，不通过不许收工）

```bash
npm run verify
```

- 覆盖：快速 Guard、自动发现的全部 Node 单测、Rust 编译与全量单测、cursor-core 检查。
- Bug 修复必须先确认新增测试在未修复实现上失败，再恢复修复并跑至全绿。
- `pre-commit` 自动跑 `npm run check:fast`；`pre-push` 自动跑与 CI 相同的 `npm run verify`。
- 本机真实客户端检查独立为 `npm run check:live`，不冒充干净环境单元测试。
- 安装钩子：`cp scripts/hooks/pre-commit scripts/hooks/pre-push .git/hooks/`。

## 2. 三条最容易踩的规矩

1. **对称路径必须一起改**：`apply_x ↔ restore_x`、接入 ↔ 还原、汉化 ↔ 还原。
   优先**收敛到同一个函数**（结构上杜绝漏改），而不是两处各写一份。
2. **判据必须覆盖完整生效链**：不能用表象（文件体积、目录存在、注入成功）
   代替真实生效状态。例：语言包「已安装」= 目录存在 **且** 不在 `.obsolete`
   **且** 注册表指向官方包。
3. **临时文件只允许 `tmp/`**：诊断脚本、探针、日志、备份一律进 `tmp/`；
   根目录与源码目录禁止 `.tmp_*` / `*.log` / `*.bak` 等（检查会拦）。
4. **兜底不得掩盖身份**：通用函数对未知输入必须显式拒绝（None/Error），
   禁止静默兜底到默认值；调用方对 id 列表循环调用前先用白名单自证身份
   （事故：Pi 页显示 Windsurf 版本，见坑点 `fallback-masks-identity`）。
4.2 **新增 Agent = 一条声明**（扩展入口，`src-tauri/src/commands/agent_spec.rs`）：
   - 元数据（id/名称/厂商/API 格式/配置路径/CLI bin/npm 包/官网）唯一真源在
     `AGENTS` 表；新增「配置式 agent」只需照抄同族条目加一条
   - `PathSource::Template("~/.xxx")` = 标准路径；特殊平台用
     `PathSource::Resolver(既有定位函数)`，**不要写第二套探测**
   - 脚手架：`node scripts/new-agent.mjs <id>` → 打印模板与自查清单
   - 校验：`npm run check:features`（声明完整性）+ 单测 `metadata_snapshot`
     （关键字段快照，改错立刻红）+ `npm run verify:versions`（探测对照）
4.5 **路径不得写死 + 平台 API 必须守仓库**（多平台/多用户纪律）：
   - 路径一律 `dirs::*` + `PathBuf::join`（用户名、盘符、安装位置全动态）
   - 安装位置探测统一走 `find_ide_exe` 四层链 / `ide_app_dir`，不许自造
   - Windows 专属 API（`creation_flags` / `windows_sys::`）必须处于
     `#[cfg(windows)]` 上下文，跨平台能力用 trait 双实现（见 `HideWindow`）
   - 检查脚本强制：生产代码禁硬编码盘符/用户目录；80 处 Windows API
     逐一核验守卫（`cert_install` UAC 子系统在白名单，待多平台化重构）
5. **只提交该提交的**：`git add` 精确指定文件，**不要用 `git add -A` / `git add .`**。
   以下永不入库：`tmp/`、`node_modules/`、`*-target/`、`*.log`、`*.bak`、
   `.env`（`.env.example` 除外）、`*.pem/*.key/*.pfx`、本地构建产物。
   检查脚本会审「忽略规则是否生效 + 已跟踪文件 + 暂存区 + 明文密钥」四项。

## 3. 项目约定补充

- **语言**：默认用简体中文回答（`.agent/中文回答.md` 是完整的语言/表达协议）
- **记忆**：历史决策与背景沉淀在 `.agent/memory.md`
- **反思**：`.agent/reflection.md`
- **CodeBuddy 专用规则**：`.codebuddy/rules/AnyBridge开发规则.mdc`
  （该目录被 gitignore，换机器请以本文件 + `docs/` 为准）

## 4. 参考资料索引

### 4.1 说明文档（入库，随时可读）

| 文件 | 用途 |
|---|---|
| `README.md` / `README_en.md` | 项目介绍、功能、安装 |
| `CHANGELOG.md` | 版本变更 |
| `docs/ARCHITECTURE(_zh).md` | 架构总览（模块划分、数据流） |
| `docs/DEVELOPMENT(_zh).md` | 本地开发、构建、调试 |
| `docs/RELEASE(_zh).md` | 打包发布流程 |
| `docs/MACOS_TROUBLESHOOTING(_zh).md` | macOS 常见问题 |
| `docs/WORKFLOW.md` | **开发工作流（强制）** |
| `docs/pitfalls.json` | **坑点库（可执行判据，检查脚本逐条跑）** |

### 4.2 设计/调研文档 `spec/`（**不入库**，本地参考）

48 篇，是开发过程的方案与调研记录。**需要背景时按主题查，不要盲读**：

| 主题 | 代表文档 |
|---|---|
| 平台适配 | `01/02-Devin兼容性`、`06-Devin支持实施计划`、`14-ClaudeCode与Codex自定义API`、`18-ClaudeCode与Codex支持`、`23-供应商解锁Codex模型`、`27-CodexChat模式`、`28-Cursor支持可行性`、`34-Codex子代理`、`37-Devin上下文与思考等级` |
| 架构 / 规划 | `07-ACP代理架构`、`08-全模型解锁注入`、`13-模型槽位管理`、`15-更多平台Tab`、`19-平台化信息架构`、`24-DevinWindsurf平台页简化`、`25-代理语义与本地代理配置`、`26-本地代理模型路由`、`35/36-扩展中心`、`插件系统设计交接文档` |
| 打包发布 | `03/04-重命名`、`09-打包发布指南`、`32-打包指南` |
| 调研报告 | `05-模型获取方案`、`10-Vision能力配置`、`11-VSCode扩展可行性`、`16-跨平台兼容检查`、`17-上下文压缩链路`、`21/22-图片理解降级`、`29-智能重试迁移`、`30/31-Codex CDP 重构`、`33-联网搜索增强`、`CC-Switch-自定义Codex供应商` |

> `spec/` 已被 gitignore（设计文档不入库），但**索引在此**——排查历史设计意图时先看这张表。

### 4.3 坑点的两个层次

| 形式 | 位置 | 用法 |
|---|---|---|
| **可执行判据**（推荐沉淀处） | `docs/pitfalls.json` | 由 `check-key-features.mjs` 逐条执行，回退即失败 |
| **叙述式踩坑记录** | `spec/27-CodexChat模式`（7 处）、`spec/10-Vision能力配置`（1 处） | 需要细节背景时查阅 |

新踩的坑 → **先写成 `pitfalls.json` 的判据**；叙述细节多时可另在 `spec/` 补一篇（不入库）。

### 4.4 其它

- `.agent/memory.md`（80KB）：历史决策、演化过程、用户偏好
- `.agent/reflection.md`：阶段性反思
- `ui/README.md`、`ui-src/README.md`、`scripts/README.md`：子目录说明

## 5. 关键实现约束（血泪教训，详见坑点库）

| 约束 | 原因 |
|---|---|
| 同步 Tauri command 里禁止 IO / 子进程 / 网络 | 会冻结 UI，必须 `async` + `spawn_blocking` |
| 改 `workbench.html` 必须保留写前快照 + 写后校验 + 损坏自愈 | 写入被中断会让客户端起不来 |
| 内联脚本必须带 CSP nonce（若原厂 CSP 有 nonce） | 否则 `'unsafe-inline'` 被 CSP3 忽略，脚本从不执行 |
| 改进程终止必须保留路径过滤 | 避免误杀其它产品的同名进程 |
| 前端点击流程：善后刷新不得挡在弹窗/警告之前 | 否则点击后卡 1-2 秒才见反馈 |
| `argv.json` 是 JSONC | 解析失败绝不用空对象覆盖用户配置 |
