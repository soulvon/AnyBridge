# AnyBridge 开发工作流（强制）

本文件是给**人和 AI 共同遵守**的约束，目标是防止「改 A 导致 B 回归」。
它不是说明文档，而是工作流的一部分——由脚本与 Git 钩子强制执行。

---

## 一、每次改动的强制动作

1. **改前：列影响面**
   - 查该函数的所有调用方（`search_content` 函数名）
   - 查它的**对称函数**：`apply_x ↔ restore_x`、`接入 ↔ 还原`、`汉化 ↔ 还原`
   - 对称逻辑优先**收敛到同一个函数**（如 `kill_antigravity_language_server`），
     而不是在两处各写一份

2. **改后：跑回归检查**
   ```bash
   npm run check:features      # 或 node scripts/check-key-features.mjs
   ```
   **失败不许收工**，必须修复后重跑至全绿。

3. **提交时自动卡**：已装 pre-commit 钩子，检查不通过**阻止提交**
   （紧急绕过 `git commit --no-verify`，但事后必须补跑）

---

## 二、坑点如何沉淀（重点）

坑**不写进散文文档**，而是写进 `docs/pitfalls.json`：

```json
{
  "id": "唯一标识",
  "title": "一句话",
  "symptom": "当时的现象",
  "lesson": "教训（判据层面的原则）",
  "check": { "type": "source_contains", "file": "相对路径", "must_contain": "关键源码串" },
  "severity": "high|medium"
}
```

`check` 字段由 `scripts/check-key-features.mjs` **逐条执行**：
- `source_contains`：源码必须包含某串（保证修复还在）
- `source_not_regex`：源码不得匹配某正则（防止回退到错误写法）

**这样沉淀出来的坑会真正反馈到工作流**——每次提交都会验证，
而不是躺在文档里等人想起。新增坑点后必须跑一次检查确认判据写得对。

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
- 提交前 pre-commit 自动跑检查（不通过阻止提交）
- 多窗口/多会话同时开发同一项目时：
  - 先 `git pull` 再动手
  - 未完成但不便提交的改动用 `git stash`，**不要长时间堆在工作区**
  - 改动量大时按模块分批提交，避免一次巨型提交难以回滚

### 只提交该提交的（强制）

- **`git add` 精确指定文件**，禁止 `git add -A` / `git add .` / `git commit -a`
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

## 六、检查脚本覆盖项（当前 57 项）

1. Rust 编译 + 全量单测
2. UI 运行时脚本语法（17 个，build:ui 不校验它们）
3. **坑点库逐条验证**（11 条）
4. **对称路径检查**（apply/restore 异步化一致、共用实现）
5. 关键判据断言（结构完整性、nonce、防死锁、asar 幂等…）
6. 本机环境实况（已启用汉化的客户端链路完整性）
