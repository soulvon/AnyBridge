# IDE-BYOK 项目全面审查报告

> 审查日期：2026-06-13
> 审查范围：全代码库（Rust 后端 + Node.js 代理 + 前端 UI）
> 审查版本：v1.2.13

---

## 目录

1. [项目概览](#一项目概览)
2. [严重问题 Critical Issues](#二严重问题-critical-issues)
3. [中等问题 Medium Issues](#三中等问题-medium-issues)
4. [轻微问题 Minor Issues](#四轻微问题-minor-issues)
5. [正面亮点](#五正面亮点strengths)
6. [优先级修复建议](#六优先级修复建议)
7. [总体评估](#七总体评估)

---

## 一、项目概览

**项目性质**：基于 Tauri v2 + Rust + Node.js 的桌面 MITM 代理应用，用于将 Windsurf/Devin IDE 的 Cascade 聊天请求劫持转发到用户自己的 API 密钥。

**技术栈**：

| 层 | 技术 | 备注 |
|---|---|---|
| 桌面框架 | Tauri v2 (Rust) | 自定义无边框窗口、系统托盘 |
| 代理服务 | Node.js 22 (pkg → EXE) | Protobuf 解析 + SSE 流式转发 |
| 前端 | 原生 HTML/CSS/JS | 无构建工具，Tauri 直接加载 `ui/` |
| 协议 | Connect-RPC + Protobuf | 逆向自 Windsurf 的 `api_server_pb` |
| 安全 | 反调试 + 完整性校验 + DPAPI | 防篡改与防逆向 |

**文件统计**：

| 目录 | 文件数 | 代码行（估算） |
|---|---|---|
| `src-tauri/src/` | 18 (.rs) | ~3,500 |
| `sidecar/` | 16 (.js) | ~8,000 |
| `ui/` | 11 (.html/.css/.js) | ~3,800（index.html 2800 行）|
| `scripts/` | 44 | ~2,000 |

---

## 二、严重问题 Critical Issues

### 2.1 安全问题

#### 2.1.1 API Key 脱敏逻辑不足 ⚠️ 高危

**位置**：`sidecar/mitm-logger.js:42-56`

**问题**：API Key 脱敏保留前后 4 字符（`val.slice(0, 4) + '***' + val.slice(-4)`），对于典型 20-40 字符的 API Key，剩余信息量仍足以辅助社会工程学或暴力破解。短密钥（≤8 字符）虽然直接替换为 `***REDACTED***`，但此类密钥本身就不安全。

**影响**：开启 `BYOK_MITM_LOG=true` 后，日志文件可能泄露用户 API 密钥。

**建议**：
- 改为仅保留前 2 + 后 2 字符
- 或完全移除密钥值，只记录密钥是否存在（`present: true/false`）
- 同时检查 `hybrid-server.js` 和 `handlers/chat.js` 中的 MITM 日志调用，确保不绕过脱敏

---

#### 2.1.2 调试图片代码在关闭时仍执行解析逻辑 ⚠️ 低危

**位置**：`sidecar/hybrid-server.js:602-633`、`sidecar/handlers/parse-request.js:427-461`

**问题**：`DEBUG_IMAGES` 环境变量只控制 `console.log` 输出，但完整的图片数据解析、字段遍历和 `Buffer` 操作仍然执行。

**影响**：不必要的 CPU 和内存开销，但由于 `DEBUG_IMAGES` 默认关闭，实际影响有限（只在调试时有性能损耗）。

**建议**：将整个调试块（包括数据解析）包在 `if (DEBUG_IMAGES)` 内。

---

#### 2.1.3 反调试机制过于激进，可能误杀合法用户 ⚠️ 中危

**位置**：`src-tauri/src/antidebug.rs:16-34`

**问题**：
- 连续 3 次检测到异常后直接 `std::process::exit(1)`，无任何用户提示
- Timing 阈值设为 1 秒，在以下环境可能误判：
  - 高 CPU 负载的 CI/CD 机器
  - 虚拟机环境（时钟漂移更严重）
  - 运行杀毒软件的系统（`IsDebuggerPresent` 对注入型安全软件会误报）
- macOS 实现直接返回 `false`（形同虚设），Linux 仅依赖 `/proc/self/status`

**影响**：合法用户在特定环境下遭遇应用闪退，无法诊断原因。

**建议**：
- 添加环境变量 `BYOK_DISABLE_ANTIDEBUG=1` 让高级用户绕过
- 提高 timing 阈值到 3 秒
- 退出前通过 Tauri 事件弹窗提示"检测到调试环境，应用即将退出"
- 考虑将 `STRIKE_LIMIT` 从 3 提高到 5

---

#### 2.1.4 MITM 证书私钥明文存储 ⚠️ 高危

**位置**：证书生成逻辑（`src-tauri/src/commands/system.rs`），存储路径 `%APPDATA%\ide-byok\certs\`

**问题**：生成的 CA 私钥（`ca-key.pem`）以明文 PEM 格式存储在磁盘上，无加密保护。任何有文件系统访问权限的进程都可以读取该私钥，进而伪造任意域名的 TLS 证书。

**影响**：
- **所有用户**都受影响（不同于调试日志只在开启时泄露）
- 恶意软件可读取私钥后在后台长期进行中间人攻击
- 私钥泄露后用户无感知，难以检测
- 卸载软件不会自动撤销已安装到系统的证书

**建议**：
- Windows：使用 DPAPI (`CryptProtectData`) 加密私钥，运行时解密
- macOS：使用 Keychain Services 存储
- Linux：使用 libsecret / 加密文件系统
- 或至少设置文件 ACL 为仅当前用户可读（Windows: icacls / macOS: chmod 600）
- 在首次生成时弹窗警告用户保护私钥

---

### 2.2 架构与设计问题

#### 2.2.1 重试逻辑重复实现，资源泄漏风险 ⚠️ 中危

**位置**：`sidecar/handlers/chat.js:264-360` vs `sidecar/retry.js`

**问题**：
1. **双重实现**：`chat.js` 自行实现了指数退避重试，与 `retry.js` 提供的通用 `withRetry()` 包装器功能重复

2. **定时器泄漏**：客户端断开时，`res.on('close')` 监听器只清理了外层作用域的 `retryTimer`，但故障转移时内层闭包创建的新定时器会泄漏。

   **场景复现**：
   - 请求尝试供应商 A，失败
   - `onFailover` 设置 `retryTimer = setTimeout(...)`
   - 客户端断开，`close` 监听器清理了外层的 `null`
   - `setTimeout` 回调仍会执行，尝试供应商 B（客户端已不存在）

3. **SSE 畅形数据**：`parseSSEChunk` 和 `parseOpenAISSEChunk` 在遇到畸形数据时可能抛出未捕获异常。

**影响**：
- 需要高并发 + 故障转移场景才触发（不是必现）
- 高并发时定时器累积可能导致内存增长
- 畸形 SSE 数据导致代理进程崩溃

**建议**：
- 统一使用 `retry.js` 的 `withRetry()` 包装器，移除 `chat.js` 中的重复逻辑
- 在 `processPart` 中添加 try-catch
- 添加 `process.on('uncaughtException')` 兜底

---

#### 2.2.2 状态管理混乱：缓存失效策略不可靠 ⚠️ 中危

**位置**：`sidecar/config-cache.js`、`sidecar/provider-pool.js:194-247`

**问题**：
1. **Mtime 不可靠**：配置缓存使用文件 `mtime` 判断失效，但以下场景会导致缓存不刷新：
   - 系统时钟回拨（NTP 校正、虚拟机快照恢复）
   - 快速连续写入（mtime 精度只到秒，1 秒内多次修改无法区分）
   - 网络文件系统（SMB/NFS）的 mtime 可能不实时更新

2. **能力标记批量写入无上限**：`pendingCapsWrites` Map 在高并发场景下可能累积大量待写条目。虽然 `CAPS_FLUSH_DELAY_MS=5000` 会定期刷盘，但如果 5 秒内涌入数千个请求，Map 可能增长到数千条目。

**影响**：
- 配置更新后代理不生效（用户需重启代理）
- 内存峰值可能导致 OOM

**建议**：
- 使用版本号/递增计数器替代 mtime 判断缓存失效
- 在 `writeJsonAtomic` 后主动调用 `markProvidersDirty()`
- 限制 `pendingCapsWrites` 最大条目数（如 500），超出时立即刷盘

---

#### 2.2.3 单进程架构缺少全局异常兜底 ⚠️ 中危

**位置**：`sidecar/hybrid-server.js`、`sidecar/proxy-entry.js`

**问题**：代理服务是单进程架构，任何未捕获的异常都会导致进程退出。当前代码中以下路径缺少保护：

| 场景 | 位置 | 风险 |
|---|---|---|
| Protobuf 解析错误 | `proto.js:parseFields` 内部 | 畸形请求导致进程崩溃 |
| SSE 畸形数据 | `anthropic-stream.js` / `openai-stream.js` | 上游返回非 SSE 格式数据 |
| MITM 证书加载失败 | `hybrid-server.js:68-74` | `MITM_CERT`/`MITM_KEY` 为 undefined 时 TLS 握手崩溃 |
| 文件写入冲突 | `writeJsonAtomic` rename 阶段 | 多进程同时写同一文件 |

**影响**：用户在使用过程中遭遇代理崩溃，需要手动重启。

**建议**：
- 在 `proxy-entry.js` 添加 `process.on('uncaughtException')` 和 `process.on('unhandledRejection')`，记录日志后尝试恢复
- 为所有请求处理函数添加顶层 try-catch
- 证书加载失败时降级为非 MITM 模式而非崩溃

---

### 2.3 性能问题

#### 2.3.1 HTTPS Agent 连接池耗尽风险 ⚠️ 中危

**位置**：`sidecar/handlers/chat.js:40-45`

**问题**：
- 全局共享一个 `HTTPS_AGENT`（`maxSockets=64`, `maxFreeSockets=16`）
- 故障转移场景下，一个请求可能依次尝试多个目标供应商，每次创建新连接
- `UPSTREAM_TIMEOUT_MS=300000`（5 分钟），意味着挂起的连接会长时间占用 socket
- 高并发 + 高故障率场景下，连接池可能在 5 分钟内被耗尽

**影响**：新请求被阻塞，用户看到"无法连接"错误。

**建议**：
- 降低 `UPSTREAM_TIMEOUT_MS` 到 60 秒（大部分 API 在 10 秒内返回首字节，60 秒足够覆盖慢速生成）
- 或为每个供应商创建独立 Agent（隔离故障域）
- 添加连接池监控指标，在仪表盘上展示活跃连接数

---

#### 2.3.2 高频文件 I/O：GetUserStatus 心跳写入 ⚠️ 中危

**位置**：`sidecar/hybrid-server.js:83-91`

**问题**：IDE 每 1-2 秒发送 `GetUserStatus` 心跳，代理每次都计算 `ide-models.json` 的 SHA1 签名（`hashModelList`），并可能每 10 秒写一次磁盘。

**当前缓解措施**：
- `lastModelListSig` 去重（同签名不重写）
- `lastModelCaptureLogAt` 5 秒日志去重
- `lastModelRewriteLogAt` 写入日志去重

**残留问题**：
- SHA1 计算仍每次执行（对 100+ 模型列表约 30KB 数据，成本可忽略但可优化）
- 10 秒间隔在高频心跳下仍意味着每分钟 6 次磁盘写入

**建议**：
- 将去重间隔提高到 60 秒
- 或只在模型列表真正变化时写入（当前已部分实现，但 `unlockModels` 的结果缓存有效期太短）

---

#### 2.3.3 Stats 内存增长 ⚠️ 低危

**位置**：`sidecar/stats.js:194-233`

**问题**：
- `state.recent` 保留最近 20 条请求记录，已限制
- `state.byModel` 是无限增长的 Map（按模型 ID 累计请求数），但每日重置
- `state.history` 保留历史天数统计，最多 365 天

**影响**：长时间运行后内存占用缓慢增长，但预估 24 小时 < 10MB，可接受。

**建议**：在 `rollDayIfNeeded()` 时清理 `byModel`。

---

### 2.4 代码质量问题

#### 2.4.1 Rust unwrap 滥用导致 panic ⚠️ 中危

**位置**：`src-tauri/src/commands/config.rs:418,430,532,546,571,582,594` 等（约 9 处）

**问题**：`serde_json::to_vec(&body).unwrap()` 在以下边缘情况会 panic：
- 构造的 JSON body 包含非 UTF-8 字符
- 内存不足

Rust panic 在 Windows 下会弹出"程序已停止工作"对话框，体验极差。

**典型代码**：
```rust
// config.rs:418
(serde_json::to_vec(&body).unwrap(), ...)
```

**影响**：非预期的应用崩溃，用户无法理解原因。

**建议**：用 `.map_err(|e| e.to_string())?` 替换所有 `.unwrap()`，让错误优雅地传播到前端。

---

#### 2.4.2 前端代码耦合度高 ⚠️ 低危

**位置**：`ui/index.html`、`ui/assets/scripts/*.js`

**问题**：
- HTML 中大量内联事件处理器（`onclick`、`onchange`），约 50+ 处
- JS 文件之间没有模块化，所有函数在全局作用域
- CSS 虽然拆分了，但依赖 `@import` 顺序，新增文件容易遗漏
- `index.html` 单文件 109KB，维护困难

**当前状态**：`ui/README.md` 已规划了迁移路线图，但尚未实施。

**影响**：维护成本高，重构困难。

**建议**：按 `ui/README.md` 的规划逐步实施：
1. 先迁移内联事件到 `data-action` + 事件委托
2. 再改为 ES 模块
3. 最后抽共享层

---

## 三、中等问题 Medium Issues

### 3.1 功能缺陷

#### 3.1.1 图片理解不完整

**位置**：`问题追踪-IssueTracking.md:1`、`sidecar/provider-pool.js:175`

**问题**：用户反馈"使用自定义模型时，无法理解图片"。

**排查**：
- `parse-request.js:135-145` 正确解析了图片数据（base64 + MIME type）
- `chat.js:109-113` 检测到图片后优先路由到支持 Vision 的供应商
- **根因**：`provider-pool.js:175` 默认 `vision: true`（过于乐观），导致不支持图片的模型也被选中，但实际请求失败时错误信息不明确

**建议**：
- 将 `vision` 默认值改为 `false`，只有明确测试通过的模型才标记为 `true`
- 在请求失败时回写更明确的错误消息到 IDE

---

#### 3.1.2 大文件写入失败率高

**位置**：`问题追踪-IssueTracking.md:3`

**问题**：用户反馈"写入大文件好像失败率很高"。

**排查**：
- Windsurf 的 `write_to_file` 工具有传输层限制（~8192 tokens），超出会被截断
- 代理层没有针对文件写入的特殊处理
- 可能是工具调用响应被截断后 IDE 认为操作失败

**建议**：
- 在 System Prompt 中添加"大文件请分块写入"的提示
- 或在代理层自动检测超长 `write_to_file` 并拆分为多次调用
- 考虑添加工具调用级别的重试机制

---

#### 3.1.3 响应失败无重试提示

**位置**：`问题追踪-IssueTracking.md:5`

**问题**：用户反馈"响应慢，失败了不会进行重试"。

**排查**：
- `retry.js` 提供了完整的重试机制（默认 5 次，指数退避 + 全抖动）
- `chat.js:320-330` 确实实现了重试逻辑
- **根因**：用户界面没有"正在重试"的提示，用户以为卡住了

**建议**：
- 在 IDE 中回写"⏳ 上游超时，正在重试 (1/5)..."的流式消息
- 或在 Tauri 前端的日志面板中高亮显示重试事件

---

#### 3.1.4 消息回弹问题

**位置**：`问题追踪-IssueTracking.md:9`

**问题**：用户反馈"发消息回弹能不能解决"。

**可能原因**：
- IDE 发送消息后，代理劫持请求但上游返回错误，IDE 显示消息发送失败
- 代理重启时正在处理的请求丢失
- Protobuf 响应构造不正确，导致 IDE 客户端解析失败

**建议**：
- 添加请求生命周期追踪（request ID → 状态：received → routing → streaming → done/error）
- 在代理重启时优雅关闭（等待进行中的请求完成）

---

### 3.2 兼容性问题

#### 3.2.1 Windows 防病毒软件冲突

**位置**：`README.md:116`

**问题**：防病毒软件可能拦截 Rust 编译产物，导致 `os error 5/32`（文件占用）。

**建议**：
- 打包脚本中添加自动检测，提示用户将 `src-tauri/target` 添加到白名单
- 在 preflight 检查中添加杀毒软件检测

---

#### 3.2.2 Devin 模型目录不完整

**位置**：`sidecar/windsurf-catalog.js`、`sidecar/rename-models.js`

**问题**：模型目录和重命名逻辑主要基于 Windsurf 的 protobuf schema，Devin 的支持是后加的。`windsurf-catalog.js` 名称本身暗示只有 Windsurf 数据。

**建议**：
- 补充 Devin 专用模型目录
- 或将 `windsurf-catalog.js` 重命名为 `model-catalog.js` 并合并两个 IDE 的模型数据

---

#### 3.2.3 跨平台路径硬编码

**位置**：多处

**问题**：部分代码硬编码了 Windows 路径（如 `AppData/Roaming`），虽然有 `process.platform` 判断，但 `hybrid-server.js:604` 的 debug dump 路径硬编码为 `AppData/Roaming/ide-byok/debug-dumps`，macOS/Linux 无法使用。

**建议**：统一使用 `configDir()` 函数。

---

### 3.3 文件与资源管理

#### 3.3.1 临时文件清理

**问题**：
- `writeJsonAtomic` 写入临时文件 `${file}.tmp-${pid}-${timestamp}`，如果进程在 `renameSync` 前崩溃，临时文件会残留
- `scripts/` 目录下有大量临时脚本（44 个），部分是调试用途

**建议**：
- 启动时清理 `.tmp-` 后缀的残留文件
- 定期清理 `scripts/` 下的调试脚本

---

#### 3.3.2 日志文件无限增长

**位置**：`sidecar/mitm-logger.js`

**问题**：MITM 日志和 RPC 审计日志按日期滚动，但没有自动清理机制。如果长期开启，可能积累大量日志文件。

**建议**：添加日志保留天数配置，默认 30 天自动清理。

---

## 四、轻微问题 Minor Issues

### 4.1 文档问题

| 问题 | 位置 | 建议 |
|---|---|---|
| README 版本号过时 | `README.md:5` 显示 v1.2.7，实际 v1.2.13 | 使用脚本从 `package.json` 自动同步 |
| CHANGELOG 中英混用 | CHANGELOG 全中文，代码注释/commit 英文 | 统一为英文（便于国际化） |
| `.env.example` 格式示例不完整 | 缺少 DeepSeek / DashScope 等新增供应商的配置示例 | 补充 |
| `scripts/README.md` 不完整 | 只描述了部分脚本 | 补充所有脚本的用途说明 |

---

### 4.2 测试覆盖不足

**现状**：整个项目没有任何自动化测试。

**缺失的关键测试**：

| 模块 | 建议测试类型 | 优先级 |
|---|---|---|
| `proto.js` — Protobuf 编解码 | 单元测试：已知输入/输出对 | P0 |
| `retry.js` — 重试逻辑 | 单元测试：各种错误类型、退避计算 | P0 |
| `parse-request.js` — 请求解析 | 单元测试：各种消息类型（文本/图片/工具调用） | P1 |
| `build-response.js` — 响应构造 | 单元测试：各种 stop_reason | P1 |
| `normalizeOpenAIApiPath` | 单元测试：各种 URL 格式 | P1 |
| 端到端流程 | 集成测试：启动代理 → 发送模拟请求 → 验证响应 | P2 |
| Rust 命令层 | 单元测试：配置读写、证书生成 | P2 |

**建议**：
- Node.js 端使用 Node 内置 `node:test`
- Rust 端使用 `#[cfg(test)]` 模块
- 添加 CI 中的自动化测试步骤

---

### 4.3 代码风格问题

| 问题 | 位置 | 建议 |
|---|---|---|
| 混用 `var`/`let`/`const` | `sidecar/handlers/chat.js` | 统一使用 `const`/`let` |
| 魔法数字 | `MAX_TOKENS=16384` 硬编码 | 提取为环境变量（已部分实现） |
| 过长函数 | `handleGetChatMessage` 约 180 行 | 拆分为子函数 |
| 重复的 configDir 函数 | 4 个文件各实现一份 | 提取到 `config-cache.js` 统一导出 |

---

## 五、正面亮点 Strengths

### 5.1 架构设计优秀

- ✅ **混合代理架构**（MITM + 直连）设计合理，只劫持目标流量（`GetChatMessage`），其他流量透传
- ✅ **故障转移机制**完善，支持多供应商级联重试，指数退避 + 全抖动避免惊群
- ✅ **Protobuf 逆向工程**质量高，Connect-RPC 流式响应实现正确，字段映射准确
- ✅ **Gemini Schema 自动探测**功能巧妙，首次遇到 400 自动切换兼容模式并持久化记忆

### 5.2 用户体验良好

- ✅ **环境检测**（preflight check）非常详细，8 大类覆盖路径/证书/端口/供应商等，帮助用户快速定位问题
- ✅ **证书自动生成 + 一键安装**，降低上手门槛
- ✅ **实时日志 + 统计面板**，可观测性强
- ✅ **遥测屏蔽**功能保护用户隐私

### 5.3 安全意识强

- ✅ **反调试机制**（虽然过于激进，但说明有安全意识）
- ✅ **完整性校验**（sidecar / resources 哈希验证，基线首次记录后续比对）
- ✅ **MITM 日志默认关闭**，避免敏感信息泄露
- ✅ **API Key 脱敏**（虽然不够强，但有这个意识）
- ✅ **原子文件写入**（`writeJsonAtomic`），避免配置文件损坏

### 5.4 工程实践

- ✅ **原子文件写入**避免配置损坏
- ✅ **端口回收**机制（`listenWithReclaim`）处理僵尸进程
- ✅ **Sidecar 进程管理**完善（kill tree、崩溃恢复、孤儿清理）
- ✅ **IDE 配置自动备份与还原**，确保异常退出不残留

---

## 六、优先级修复建议

### P0 — 立即修复（影响安全/稳定性）

| # | 问题 | 章节 | 预估工时 |
|---|---|---|---|
| 1 | API Key 脱敏逻辑加强 | 2.1.1 | 0.5h |
| 2 | 重试逻辑统一 + 定时器泄漏修复 | 2.2.1 | 4h |
| 3 | Rust unwrap 替换为错误传播 | 2.4.1 | 2h |
| 4 | 全局异常兜底（uncaughtException） | 2.2.3 | 1h |

### P1 — 尽快修复（影响用户体验）

| # | 问题 | 章节 | 预估工时 |
|---|---|---|---|
| 5 | 反调试机制优化（添加环境变量绕过） | 2.1.3 | 1h |
| 6 | 图片支持修复（vision 默认值） | 3.1.1 | 0.5h |
| 7 | 大文件写入优化 | 3.1.2 | 2h |
| 8 | HTTPS Agent 连接池优化 | 2.3.1 | 1h |
| 9 | 调试图片代码优化（条件执行） | 2.1.2 | 0.5h |
| 10 | 重试提示消息 | 3.1.3 | 1h |

### P2 — 计划修复（技术债务）

| # | 问题 | 章节 | 预估工时 |
|---|---|---|---|
| 11 | 状态管理重构（mtime → 版本号） | 2.2.2 | 4h |
| 12 | 前端模块化 | 2.4.2 | 16h |
| 13 | 证书私钥加密存储 | 2.1.4 | 4h |
| 14 | 补充单元测试 | 4.2 | 8h |
| 15 | 统一 configDir 函数 | 4.3 | 1h |
| 16 | 日志文件自动清理 | 3.3.2 | 1h |

---

## 七、总体评估

| 维度 | 评分 | 说明 |
|---|---|---|
| **代码质量** | ⭐⭐⭐⭐ (4/5) | 核心逻辑正确，protobuf 逆向工程质量高，但存在边缘情况未处理 |
| **安全性** | ⭐⭐⭐ (3/5) | 有安全意识（反调试、完整性校验、遥测屏蔽），但密钥保护和脱敏需加强 |
| **性能** | ⭐⭐⭐⭐ (4/5) | 整体性能良好，但存在连接池和 I/O 瓶颈风险 |
| **可维护性** | ⭐⭐⭐ (3/5) | 后端结构清晰，但前端耦合度高、缺少测试 |
| **用户体验** | ⭐⭐⭐⭐ (4/5) | 环境检测和错误引导做得好，但失败提示和重试可见性需改进 |
| **项目成熟度** | ⭐⭐⭐⭐ (4/5) | 功能完整，快速迭代（v1.2.5→1.2.13 仅 4 天），但缺少自动化测试 |

---

## 结论

IDE-BYOK 是一个**设计优秀、实现扎实的项目**，核心的 MITM 代理 + Protobuf 逆向 + 多供应商故障转移链路已经达到生产可用水平。主要问题集中在三个方面：

1. **安全细节**：API Key 脱敏、证书私钥保护、反调试误杀
2. **错误处理**：重试逻辑重复、定时器泄漏、全局异常兜底缺失
3. **技术债务**：前端耦合、测试缺失、状态管理可靠性

建议按 P0 → P1 → P2 优先级逐步修复，P0 项可在 1-2 天内完成，P1 项约 1 周，P2 项按迭代节奏安排。
