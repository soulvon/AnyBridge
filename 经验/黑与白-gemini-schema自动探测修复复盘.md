## 黑与白 Gemini Schema 自动探测修复复盘

调查时间：2026-06-05

---

### 一、背景

在 `IDE-BYOK` 的 Electron/Tauri 开发模式中，用户通过供应商 `黑与白` 调用 `gemini-3.5-flash` 时持续出现 `HTTP 400`，且重启后问题依旧。

目标：
- 快速定位 400 根因（非猜测）
- 修复后确保同类问题可自动恢复
- 将修复策略持久化，避免重复踩坑

---

### 二、现象与关键证据

### 2.1 现象
- 用户请求在路由层命中第三方供应商后失败
- 报错为“全部供应商失败，最后错误 HTTP 400”

### 2.2 证据来源
- `mitm` 日志：`%APPDATA%\ide-byok\mitm-logs\mitm-2026-06-05.jsonl`
- 通过筛选 `providerName == 黑与白` 的 `downstream` 记录，确认上游真实响应体

### 2.3 核心结论
Gemini（OpenAI 兼容层）不接受 tools JSON Schema 中部分字段，典型是：
- `exclusiveMinimum`
- `propertyNames`
- 错误上下文含 `function_declarations`

因此不是用户输入问题，也不是模型映射丢失，而是**工具参数 schema 兼容性问题**。

---

### 三、第一次修复后仍失败的真实原因

已改 `sidecar` 源码后，仍然 400。排查后确认：
- `tauri dev` 实际运行的是外置二进制 `ide-byok-proxy`（`src-tauri/binaries`）
- 并非直接运行 `sidecar/*.js`

所以“源码已改但运行仍旧逻辑”的原因是：**未重新打包 sidecar 二进制并替换**。

---

### 四、落地改造（已实现）

### 4.1 工具 Schema 兼容清洗
文件：`sidecar/handlers/chat.js`

新增逻辑：
- `sanitizeJsonSchemaForGemini(schema)`：递归清洗不兼容字段
- `normalizeToolSchema(inputSchema, model, forceGeminiCompat)`：支持按模型或强制兼容模式处理

覆盖链路：
- OpenAI Responses
- OpenAI Chat Completions

### 4.2 自动探测 + 同请求自动修复重试
文件：`sidecar/handlers/chat.js`

新增逻辑：
- `shouldAutoEnableGeminiSchemaCompat(statusCode, errBody)`
- 当命中 400 且错误特征匹配时：
  1. 自动启用 Gemini 兼容模式
  2. 同一次请求立即重试一次（无感恢复）
  3. 避免循环重试（仅一次）

### 4.3 持久化“记住设置”
文件：`sidecar/provider-pool.js`

新增逻辑：
- `rememberProviderToolSchemaCompat(providerId, 'gemini')`
- 写回 `providers.json` 的 `capabilities.toolSchemaCompat = 'gemini'`
- 原子写入（tmp + rename），降低配置损坏风险

效果：该供应商后续请求可直接走兼容模式，无需再次触发 400 学习。

### 4.4 UI 侧可见与防覆盖
文件：`ui/index.html`

新增逻辑：
- 能力标签显示：`Schema兼容`（已自动学习）
- 保存供应商配置时保留已有 `capabilities` 扩展字段，避免把自动学习结果覆盖掉

---

### 五、发布与运行注意事项

本项目 dev 模式关键点：
- 需要重打 sidecar 二进制：`npx pkg proxy-entry.js --targets node22-win-x64 --output ..\src-tauri\binaries\ide-byok-proxy-x86_64-pc-windows-msvc.exe`
- 然后重启 `tauri:dev`

若出现 `os error 5`（可执行文件被占用）：
- 结束 `ide-byok.exe` / `ide-byok-proxy.exe` 残留进程后再启动

---

### 六、验证结果

- 同类请求恢复正常（用户反馈“现在正常了”）
- 400 的 schema 兼容错误得到自动探测与自动修复
- 修复策略可以持久化记忆

---

### 七、经验 Checklist（后续同类问题直接套用）

- 先看 `mitm` 下游响应体，不靠猜
- 发现 Gemini/OpenAI 兼容层 400 时优先检查 tools schema
- 改 `sidecar` JS 后必须确认运行时是否为外置二进制
- 每次改动后执行：语法检查 + lints + 二进制重打包 + 进程重启
- 对“可学习型兼容”问题优先做自动探测 + 自动修复 + 持久化

---

### 八、可继续优化项

- 将“自动学习记录”加入独立审计日志（包含触发时间、供应商、模型）
- 为 `toolSchemaCompat` 增加手动开关（启用/关闭/重置）
- 扩展更多 provider 的 schema 兼容策略模板
