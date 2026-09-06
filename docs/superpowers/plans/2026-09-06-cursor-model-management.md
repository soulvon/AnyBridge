# Cursor 模型管理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现供应商只配置一次、Cursor 平台独立选择模型、小白三步添加、Cursor Core 自动同步且不影响其他 IDE 的完整闭环。

**Architecture:** `providers.json` 继续作为供应商唯一数据源，`proxy-routes.json` 继续保存跨 IDE 共享路由并增加不可变 `uid`，新增 `cursor-models.json` 保存 Cursor 平台绑定。Cursor Core 按 Cursor 绑定关联共享路由生成模型目录，不再默认同步全部 OpenAI 路由。前端复用现有 Devin/Windsurf 控制台布局和 CodeBuddy 添加模型交互。

**Tech Stack:** Rust、Tauri 2、Serde/serde_json、SHA-256 内容修订、Rust Cursor Core、原生 HTML/CSS/ES Modules、Node UI 校验。

**Design Spec:** `docs/superpowers/specs/2026-09-06-cursor-model-management-design.md`

---

## 实施范围

### 首版必须完成

- 共享路由稳定 `uid` 与旧数据兼容；
- Cursor 平台绑定存储与旧路由一次性迁移；
- Cursor 模型增、改、移除、启停和安全供应商模型目录；
- Cursor Core 按平台绑定同步；
- 后端提供真实同步修订与状态；
- 与现有平台同构的 Cursor 主页面和添加模型页面；
- 小白三步添加闭环；
- 删除绑定不影响共享路由和其他 IDE。

### 第二阶段，不阻塞首版

- 复制 Cursor 配置；
- 真实模型测试与首包延迟；
- Agent/Vision/Stream 能力覆盖（需 Core 真实消费后再开放）；
- 将 Cursor 绑定抽象成跨平台通用 Binding 框架。

## 文件职责

### 新建

- `src-tauri/src/commands/cursor_models.rs`
  - Cursor 绑定结构、存储、revision、迁移；
  - 安全供应商目录；
  - 批量添加、更新、移除、启停；
  - 共享路由自动创建/复用；
  - 配置写锁和失败回滚。
- `ui-src/partials/pages/platform-cursor-add.html`
  - Cursor 添加模型独立页面。

### 修改

- `src-tauri/src/commands/proxy_routes.rs`
  - `ProxyRoute.uid`；
  - 旧路由稳定 UID 生成和兼容写回；
  - 按 UID 查询与安全写入辅助函数。
- `src-tauri/src/commands/mod.rs`
  - 导出 `cursor_models`；
  - 必要时提供跨配置文件的进程内写锁。
- `src-tauri/src/lib.rs`
  - 注册 Cursor 模型命令。
- `src-tauri/src/commands/cursor_core.rs`
  - Cursor 绑定文件路径；
  - config/core revision；
  - sync state、同步时间/错误、同步模型数；
  - 启动、同步和预检改为绑定模型数量。
- `cursor-core/src/anybridge.rs`
  - 读取绑定 + 共享路由；
  - 按 `routeUid` 关联；
  - 映射 Cursor 专属参数；
  - 禁止敏感字段进入 Core 模型目录。
- `cursor-core/src/app.rs` 及相关配置结构
  - 接收 Cursor 绑定文件路径。
- `ui-src/partials/pages/platform-cursor.html`
  - 主页面同构布局与正确平台语义。
- `ui-src/index.html`
  - 引入 Cursor 添加页面。
- `ui/assets/scripts/10-shell.js`
  - 将 `platform-cursor-add` 归入平台 Tab。
- `ui/assets/scripts/55-platforms.js`
  - 主列表、添加页、编辑、启停、移除、同步状态；
  - 删除旧的全局路由子集渲染和虚假测速逻辑。
- `ui/assets/styles/50-platforms.css`
  - 仅增加 Cursor 特有的小范围样式，优先复用现有平台和 `cb-add-*` 组件。
- `docs/cursor-backend-api.md`
  - 更新最终命令契约和同步状态字段。

---

## Task 1：共享路由增加稳定 UID

**Files:**
- Modify: `src-tauri/src/commands/proxy_routes.rs`
- Test: `src-tauri/src/commands/proxy_routes.rs`

- [ ] **Step 1：编写旧路由迁移失败测试**

覆盖：

- 缺少 `uid` 的旧路由读取后获得非空 UID；
- 同一旧路由多次读取生成相同 UID；
- 不同供应商/模型目标不会生成相同 UID；
- 用户修改公开 `id` 后，已有 `uid` 保持不变。

- [ ] **Step 2：运行定向测试并确认失败**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml proxy_routes -- --nocapture
```

Expected: 新增 UID 测试失败或结构尚无 `uid`。

- [ ] **Step 3：实现 `ProxyRoute.uid` 和稳定迁移**

要求：

- 新路由 UID 使用随机、不可变标识；
- 旧路由 UID 使用规范化后的供应商/模型目标和旧 ID 生成稳定摘要；
- `normalize_routes` 不覆盖已有 UID；
- `read_routes` 检测迁移后原子写回；
- Sidecar 读取未知 `uid` 字段应保持兼容。

- [ ] **Step 4：运行测试与兼容检查**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml proxy_routes -- --nocapture
node --test sidecar/config-cache.test.js
```

Expected: PASS。

---

## Task 2：Cursor 平台绑定存储与迁移

**Files:**
- Create: `src-tauri/src/commands/cursor_models.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Test: `src-tauri/src/commands/cursor_models.rs`

- [ ] **Step 1：定义数据结构测试**

覆盖：

- 空文件返回版本 1 空列表；
- revision 由规范化模型内容计算，不包含运行时状态；
- `exposedModelId` 唯一；
- `routeUid` 必须存在；
- Cursor 绑定文件不允许出现 API Key。

- [ ] **Step 2：实现存储结构**

结构至少包含：

```rust
CursorModelsStore {
    version,
    revision,
    migration_version,
    migration_notice_pending,
    models,
}

CursorModelBinding {
    id,
    route_uid,
    display_name,
    exposed_model_id,
    enabled,
    sort_order,
    capability_policy,
    cursor_overrides,
}
```

配置路径固定为 AnyBridge 配置目录下的 `cursor-models.json`。

- [ ] **Step 3：编写旧配置迁移测试**

覆盖：

- 文件不存在时从启用且包含 OpenAI 暴露格式的旧共享路由导入；
- 迁移只执行一次；
- 不修改共享路由 ID、目标和启用状态；
- 迁移数量可供前端一次性提示；
- 移除 Cursor 绑定不删除共享路由。

- [ ] **Step 4：实现迁移与原子写入**

- 使用配置写锁；
- 临时文件写入后反序列化验证；
- 原子替换；
- 保留操作前字节用于失败回滚。

- [ ] **Step 5：运行定向测试**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml cursor_models -- --nocapture
```

Expected: PASS。

---

## Task 3：Cursor 模型管理命令

**Files:**
- Modify: `src-tauri/src/commands/cursor_models.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `docs/cursor-backend-api.md`

- [ ] **Step 1：实现安全供应商模型目录**

命令：`cursor_list_provider_models`

返回：

- `providerId`、`providerName`；
- 模型 `id`、`name`；
- `supportsToolCall`、`supportsImages`、`supportsReasoning`；
- `alreadyAdded` 和已有关联绑定 ID。

禁止返回：

- API Key；
- Base URL；
- 本地代理 Key；
- 供应商自定义密钥头。

- [ ] **Step 2：实现绑定列表**

命令：`cursor_list_models`

返回组合视图：

- 绑定平台字段；
- 共享路由是否存在；
- 供应商名称/上游模型只读摘要；
- 自动识别能力；
- 后端同步状态。

- [ ] **Step 3：实现批量添加**

命令：`cursor_add_models`

输入：供应商/模型选择列表和可选批量命名前后缀。

行为：

1. 获取配置写锁；
2. 复用相同供应商/模型的共享路由；
3. 不存在时创建默认共享路由；
4. 生成唯一 Cursor 模型 ID；
5. 批量创建绑定；
6. 两个文件全有或全无；
7. 返回新增、跳过和同步结果。

- [ ] **Step 4：实现更新、启停和移除**

命令：

- `cursor_update_model`
- `cursor_set_models_enabled`
- `cursor_remove_models`

要求：

- 更新只修改 Cursor 专属字段；
- 启停只修改绑定；
- 移除只删除绑定；
- 共享路由永不因 Cursor 移除而自动删除。

- [ ] **Step 5：注册命令并运行检查**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml cursor_models -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS。

---

## Task 4：Cursor Core 按平台绑定转换模型

**Files:**
- Modify: `cursor-core/src/anybridge.rs`
- Modify: `cursor-core/src/app.rs`
- Modify: Cursor Core 配置结构所在文件
- Test: `cursor-core/src/anybridge.rs`

- [ ] **Step 1：编写转换失败测试**

覆盖：

- 只导入启用的 Cursor 绑定；
- 不再导入未绑定的 OpenAI 共享路由；
- `routeUid` 缺失时返回可诊断错误或跳过并报告；
- 显示名、公开模型 ID、排序正确；
- 推理强度、上下文窗口和最大输出正确；
- 序列化结果不包含供应商 ID、上游模型和真实 API Key。

- [ ] **Step 2：实现双文件解析与关联**

新增入口接受：

- `cursor-models.json` 路径；
- `proxy-routes.json` 路径；
- 本地网关 URL；
- 本地网关 Key。

- [ ] **Step 3：保留旧迁移辅助函数**

原 `model_inputs_from_routes` 仅保留给迁移测试或兼容逻辑；正常同步必须走 Cursor 绑定。

- [ ] **Step 4：运行 Cursor Core 测试**

Run:

```powershell
cargo test --manifest-path cursor-core/Cargo.toml anybridge -- --nocapture
cargo check --manifest-path cursor-core/Cargo.toml --lib
```

Expected: PASS。

---

## Task 5：Cursor 生命周期与真实同步状态

**Files:**
- Modify: `src-tauri/src/commands/cursor_core.rs`
- Test: `src-tauri/src/commands/cursor_core.rs`

- [ ] **Step 1：扩展状态结构**

增加：

- `configRevision`
- `coreRevision`
- `syncState`
- `lastSyncAt`
- `lastSyncError`
- `configuredModels`
- `syncedModels`
- `migrationNotice`

- [ ] **Step 2：调整启动和预检**

- 模型数量来自 Cursor 绑定；
- 启动时向 Core 传入共享路由和 Cursor 绑定路径；
- Core 启动成功后执行同步并记录修订；
- `availableActions` 始终由后端生成。

- [ ] **Step 3：调整同步接口**

`cursor_sync_routes`：

- Core 未运行返回 pending 状态，而不是破坏已保存配置；
- 同步成功记录 Core revision、时间和数量；
- 失败记录错误并返回可展示状态。

- [ ] **Step 4：自动同步辅助函数**

模型命令保存成功后：

- Core 运行则调用同步；
- Core 未运行则直接返回 pending；
- 同步失败不回滚已保存模型配置。

- [ ] **Step 5：运行后端测试**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml cursor -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS。

---

## Task 6：Cursor 主页面同构重构

**Files:**
- Modify: `ui-src/partials/pages/platform-cursor.html`
- Modify: `ui/assets/scripts/55-platforms.js`
- Modify: `ui/assets/styles/50-platforms.css`

- [ ] **Step 1：统一文案和布局**

使用：

- `platform-console-head`
- `platform-console-titlebar`
- `platform-console-actions`
- `model-map-control-bar`
- 现有表格和批量工具类

文案全部改为：

- Cursor 模型列表；
- 添加模型；
- 从 Cursor 移除；
- 接入设置。

不得出现“模型映射”“添加映射”“槽位管理”。

- [ ] **Step 2：按专用接口渲染表格**

表格字段：

- Cursor 显示名；
- 模型 ID；
- 目标（供应商/模型）；
- 能力；
- 同步状态；
- 启用；
- 操作。

不再使用 `load_proxy_routes` 作为 Cursor 主列表数据源。

- [ ] **Step 3：接入状态由后端驱动**

- 使用 `availableActions`；
- 展示真实 `syncState`；
- 首次迁移提示只显示一次；
- 无模型主按钮进入添加页；
- 有模型未运行时一键接入；
- 运行时提供同步、重启和停止。

- [ ] **Step 4：移除假功能**

删除：

- `test_model_route` 不存在命令的调用；
- 随机延迟模拟；
- 前端推测同步状态；
- 旧的 Cursor 卡片流样式和无引用代码。

---

## Task 7：Cursor 添加模型页面

**Files:**
- Create: `ui-src/partials/pages/platform-cursor-add.html`
- Modify: `ui-src/index.html`
- Modify: `ui/assets/scripts/10-shell.js`
- Modify: `ui/assets/scripts/55-platforms.js`
- Modify: `ui/assets/styles/50-platforms.css`

- [ ] **Step 1：建立同构页面骨架**

参考 `platform-codebuddy-add.html`：

- 顶部返回、取消和确认；
- 左侧供应商搜索与排序；
- 右侧模型搜索、多选、全选/全不选；
- 已添加状态；
- 底部只读自动适配摘要；
- 折叠命名前后缀高级选项。

- [ ] **Step 2：加载安全供应商目录**

进入页面调用 `cursor_list_provider_models`，不得调用返回 API Key 的通用目录接口。

- [ ] **Step 3：实现小白批量添加**

- 选择供应商；
- 勾选模型；
- 确认按钮显示数量；
- 已添加项默认不可重复选择；
- 调用 `cursor_add_models`；
- 成功返回主列表；
- pending/error 同步状态明确展示但不要求重新添加。

- [ ] **Step 4：命名高级选项**

只包含：

- 原名；
- `(BYOK)` 后缀；
- 自定义前缀；
- 自定义后缀；
- 实时名称预览。

不包含 API Key、Base URL、故障转移和请求参数。

---

## Task 8：编辑、批量操作与统一路由入口

**Files:**
- Modify: `ui-src/partials/pages/platform-cursor.html`
- Modify: `ui/assets/scripts/55-platforms.js`

- [ ] **Step 1：实现批量启停和移除**

- 选择当前；
- 批量启用；
- 批量停用；
- 批量从 Cursor 移除；
- 删除文案明确“不影响供应商和其他 IDE”。

- [ ] **Step 2：实现单模型编辑**

首版字段：

- 显示名；
- 模型 ID；
- 绑定共享路由；
- 推理强度；
- 上下文窗口；
- 最大输出 Token；
- 启用状态。

Agent/Vision/Stream 只读展示，除非后端已实现真实覆盖消费。

- [ ] **Step 3：共享路由统一入口**

“编辑共享路由”跳转现有统一代理模型编辑器，并在跳转前提示：修改可能影响其他 IDE。

---

## Task 9：验证和开发版验收

**Files:**
- Modify only if checks expose defects.

- [ ] **Step 1：UI 构建与静态校验**

Run:

```powershell
npm run build:ui
npm run check:ui
```

Expected: PASS。

- [ ] **Step 2：全局挂载审计**

检查 `55-platforms.js` 所有 `g.X = X` 引用均有定义，避免再次因模块级 `ReferenceError` 导致全部数据加载失败。

- [ ] **Step 3：Rust 全量定向检查**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml cursor -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path cursor-core/Cargo.toml anybridge -- --nocapture
cargo check --manifest-path cursor-core/Cargo.toml --lib
```

Expected: PASS。

- [ ] **Step 4：真实开发版手工验收**

Run:

```powershell
npm run tauri:dev
```

检查：

1. 安装版既有供应商数据可读取；
2. Cursor 首次迁移提示正确；
3. 添加页不显示供应商密钥；
4. 三步可批量添加；
5. Core 未运行显示待同步；
6. Core 运行后自动同步；
7. 移除 Cursor 模型不影响 Devin/Windsurf 和全局路由；
8. 深浅主题与最小窗口宽度布局正常；
9. 浏览器/Tauri 控制台无未捕获异常。

---

## 实施约束

- 不修改 Cursor 登录 Token 或订阅权益；
- 不导入参考项目的前端；
- 不在 Cursor 页面复制供应商配置；
- 不在首版建设通用跨 IDE Binding 框架；
- 不实现虚假测速；
- 不删除或覆盖现有未提交的非 Cursor 改动；
- 不提交 Git commit，除非用户另行明确要求。
