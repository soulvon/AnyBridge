# AnyBridge 开发工作流（强制）

本文件是给**人和 AI 共同遵守**的约束，目标是防止「改 A 导致 B 回归」。
它不是说明文档，而是工作流的一部分——由脚本与 Git 钩子强制执行。

---

## 一、每次改动的强制动作

1. **改前：确定真实影响面**
   - 查该函数的调用方，以及 `apply_x ↔ restore_x`、接入 ↔ 还原等对称路径。
   - 改动跨模块行为时，先读 `docs/subsystems/` 中对应的运行契约。
   - 明确旧配置、旧数据和用户手动修改是否必须保留。

2. **修复 Bug：先证明测试能抓住事故**
   - 用事故的真实输入写行为测试，先在未修复实现上确认它失败，再修复至通过。
   - 不能只测叶子函数：协议转换要断言完整输出事件，配置修改要断言写入后的文件，
     接入/还原要断言整条状态变化。
   - 纯静态规则（禁止某 API、禁止绕过统一封装）使用 Guard；行为正确性必须用行为测试。

3. **改后：运行统一验证**
   ```bash
   npm run verify
   ```
   它依次执行快速检查、自动发现的全部 Node 单元测试、Rust 编译与全量单测、
   cursor-core 检查。失败不许收工；未运行的检查必须明确写明，不能省略。

4. **提交与推送自动拦截**
   - `pre-commit`：运行 `npm run check:fast`，不执行真实客户端检查。
   - `pre-push`：运行与 CI 相同的 `npm run verify`。
   - 缺少 Node.js、无法定位仓库等环境错误必须阻止操作，不得静默放行。

---

## 二、坑点如何沉淀（重点）

坑记录在 `docs/pitfalls.json`，并与真正的验证关联：

```json
{
  "id": "唯一标识",
  "title": "一句话",
  "symptom": "当时的现象",
  "lesson": "根因与以后必须遵守的规则",
  "check": { "type": "source_not_regex", "file": "相对路径", "must_not_match": "危险写法" },
  "regression_test": "测试文件::测试名",
  "severity": "high|medium"
}
```

- `check` 用于静态 Guard；`source_contains` 不能单独证明函数行为正确。
- `regression_test` 指向行为测试，由 `npm run test:unit` 或 Rust 全量测试实际执行；
  检查脚本会校验引用没有漂移。
- 新事故至少要有行为测试；重复出现或属于跨模块共性规则时，再补静态 Guard。
- 改变子系统接口、状态、运行路径或失败语义时，对应契约文档与代码同一次提交。

---

## 三、判据编写原则（血的教训）

「是否已生效 / 是否已损坏」这类判定，**必须覆盖完整链路**，
不能只看一个表象：

| 错误判据 | 正确判据 |
|---|---|
| 文件体积 > 50KB = 完好 | 含 `</body>`（结构完整性） |
| 语言包目录存在 = 已安装 | 目录存在 **且** 不在 `.obsolete` **且** 注册表指向官方包 |
| 内联脚本能注入 = 会执行 | 带 CSP nonce（否则被 CSP 拦下） |

原因：客户端重装/升级会重置外部状态，表象判据会误判并**跳过修复**。

**通用原则：读失败 = 未知，绝不当「否」处理**（源自 magpie LESSONS #8）。
任何读取配置/状态文件失败时，语义必须是「未知」并走保守路径（提示用户 /
保持现状 / 触发修复），绝不能静默当作否定值（false / 0 / 空列表）继续往下走。
安全类判定（白名单、配额、权限）尤其如此——读失败放行 = 事故。

---

## 四、改动类型对应的检查重点

| 改了什么 | 必须额外确认 |
|---|---|
| 汉化 / 接入的 apply | 对称的 restore 是否同步改 |
| 新增同步 tauri command | 含 IO/子进程/网络 → 必须 async + spawn_blocking |
| 动 workbench.html 写入 | 快照 + 写后校验 + 损坏自愈是否保留 |
| 动进程终止逻辑 | 是否保留路径过滤（避免误杀同名进程） |
| 动前端点击流程 | 善后刷新不得挡在弹窗/警告前面 |
| 动 `argv.json` / `languagepacks.json` | JSONC 解析 + 解析失败不覆盖原文件 |

---

## 五、临时文件纪律（强制）

- 诊断/构建用的临时脚本**只允许放 `tmp/`**，命名随意但必须在 `tmp/` 内
- **根目录和源码目录（src-tauri/src、ui、ui-src、scripts）禁止出现 `.tmp_*`**
  ——检查脚本会拦截，pre-commit 也会拦
- 运行日志统一写 `tmp/tauri-run.log`（启动脚本已固定）
- 临时文件用完即可删；`tmp/` 整体在 .gitignore 里，不入库

## 六、Git 提交规范

- **一个改动一个提交**，提交信息说明「改了什么 + 为什么」
- 提交前 pre-commit 运行快速检查；推送前 pre-push 运行完整 `npm run verify`
- 多窗口/多会话同时开发同一项目时：
  - **一个工作树只允许一个写入会话**；第二个会话必须另开分支或 Git worktree
  - 开工前先看 `git status --short --branch`，确认自己在目标分支、没有误吃别人的未提交改动
  - **不要共用 stash**；一个会话的 `git stash pop` 可能拿走另一个会话的现场
  - 改动量大时按模块分批提交，避免一次巨型提交难以回滚
  - 合并方向必须串行：先合并/推送一方，另一方再 rebase 并重跑 `npm run verify`

### 只提交该提交的（强制）

- **`git add` 精确指定文件**，禁止 `git add -A` / `git add .` / `git commit -a`
- **文档只提交「说明文档」，设计/调研文档不入库**：

  | 类型 | 例子 | 入库 |
  |---|---|---|
  | 说明文档（给使用者/贡献者） | `README`、`CHANGELOG`、`AGENTS.md`、`docs/{ARCHITECTURE,DEVELOPMENT,RELEASE,MACOS_TROUBLESHOOTING,WORKFLOW}`、各处 `README`、PR 模板 | ✅ |
  | 运行时资源（程序的一部分） | `cursor-core/prompt/**`（提示词模板）、`sidecar/prompts/**`、`src-tauri/resources/**`（插件自带说明/prompt） | ✅ |
  | 设计/调研/规划文档 | 调研报告、方案设计、逆向分析、规划稿、`spec/**` | ❌ 放本地或 `tmp/` |

  检查脚本对已跟踪的 `.md` 做**白名单校验**——不在清单内直接报错。
- 永不入库：`tmp/`、`node_modules/`、`src-tauri/target/`、`*.log`、`*.bak`、
  `.env`（仅 `.env.example` 可入库）、`*.pem` / `*.key` / `*.pfx` / `*.p12`、
  `*.tmp`、`.tmp_*`、`tmp_*`、编辑器/工具目录（`.codebuddy/`、`.vscode/`、`.idea/`）
- `ui/index.html` 是 **Tauri 的 frontendDist**（dev 直接读取），属于**应入库**的构建产物；
  `ui/index.html.baseline` 才是本地对比用，已被忽略
- 检查脚本「提交卫生」段会验证四项：
  1. 关键忽略规则确实生效（`git check-ignore`）
  2. 已跟踪文件里无日志/临时/敏感/构建产物
  3. 暂存区无非预期文件
  4. 暂存内容无明文密钥（`sk-xxx` / `ghp_xxx` / `AKIA...`）

---

## 七、检查入口分层（以命令为准，不维护手工清单）

| 命令 | 用途 | 时机 |
|---|---|---|
| `npm run check:fast` | UI 结构/语法、设计铁律守卫（uppercase/被禁动效硬拦；动画名/蓝紫色/小字号/彩条提示）、坑点 Guard、对称路径、新增文件行数守卫（>1500 阻断）、提交卫生 | pre-commit；开发中快速自查 |
| `npm run test:unit` | 自动发现 Node 侧单元测试 | pre-push / CI / 本地验证 |
| `node scripts/check-key-features.mjs --rust` | Rust 编译 + 全量单测 | pre-push / CI / 本地验证 |
| `npm run verify` | 快速检查 + Node 单测 + Rust 检查 + cursor-core 检查 | pre-push、PR、CI |
| `npm run check:live` | 本机真实 Windsurf/Devin 配置与汉化链路 | 显式手动验收，不冒充单元测试 |
| `npm run verify:release` | 完整验证 + 重新构建本地安装包 | 发布前；仍需按范围做产物/真机验收 |

不要在 CI 里另写一套命令清单；CI 的最终验证步骤就是 `npm run verify`。