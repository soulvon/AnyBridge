# Cursor 模型管理与接入设计

日期：2026-09-06  
状态：已确认，待实施

## 1. 产品目标

AnyBridge 采用“供应商统一管理 + 多 IDE 平台适配”模式：

- 供应商页面统一管理 API 地址、API Key、模型目录、协议能力和连接测试；
- 每个 IDE 页面复用统一供应商与模型池；
- 各 IDE 只保存自身 BYOK 特性所需的平台配置；
- 页面结构和操作语言保持一致，降低跨平台学习成本；
- 默认流程面向小白，专业能力放入高级选项。

用户理想路径：

```text
供应商配置一次
→ 进入任意 IDE 页面
→ 点击“添加模型”
→ 选择供应商并勾选模型
→ 自动完成该 IDE 的适配与接入
```

## 2. 统一平台控制台设计语言

Cursor 页面与 Devin / Windsurf 控制台同构：

1. 顶部平台接入控制台；
2. 平台模型列表工具栏；
3. 搜索、数量和批量操作；
4. 统一密度的数据表格；
5. 独立“添加模型”子页面；
6. 基础设置默认展示，高级选项折叠。

Cursor 不使用独立的视觉体系，也不向用户展示共享路由、平台绑定、Connect-RPC、Protobuf 等内部概念。

## 3. 平台语义差异

Devin / Windsurf：

```text
IDE 固定模型槽位 → AnyBridge 上游模型
```

Cursor：

```text
Cursor 自定义模型 → AnyBridge 统一模型路由 → 供应商上游模型
```

因此 Cursor 使用以下文案：

- Cursor 模型列表；
- 添加模型；
- 编辑模型；
- 从 Cursor 移除；
- 启用/停用；
- 同步状态。

不使用“模型映射”“添加映射”“槽位管理”。

## 4. Cursor 主页面

### 4.1 顶部接入控制台

复用 `platform-console-head`、`platform-console-titlebar`、`platform-console-actions`：

- Cursor 图标、标题、简短说明；
- Core 运行状态；
- 一键接入；
- 刷新状态；
- 同步模型；
- 重启 Cursor；
- 停止接入。

状态行为：

- 无 Cursor 模型：主按钮引导“添加模型”；
- 有模型、Core 未运行：主按钮显示“一键接入”；
- Core 运行：显示“已接入”，提供同步、重启和停止；
- 操作可用性使用后端 `availableActions`，不由前端自行推测。

### 4.2 模型列表工具栏

标题：`Cursor 模型列表`

说明：`从统一供应商模型池添加，只影响 Cursor 中可选的第三方模型。`

操作：

- 添加模型；
- 刷新；
- 接入设置（Core、证书与同步，不承载模型高级参数）；
- 搜索 Cursor 模型、供应商或上游模型；
- 显示模型数量；
- 选择当前；
- 批量启用、停用、移除。

### 4.3 表格字段

| 字段 | 说明 |
|---|---|
| Cursor 显示名 | Cursor 下拉列表中看到的名称 |
| 模型 ID | Cursor 请求使用的平台模型标识 |
| 目标 | 统一供应商 / 上游模型 |
| 能力 | Agent、Thinking、Vision |
| 同步状态 | 已同步、待同步、同步失败 |
| 启用 | 仅控制是否向 Cursor 暴露 |
| 操作 | 首版提供编辑、移除；复制和真实测试在第二阶段提供 |

“移除”只删除 Cursor 平台配置，不删除供应商、共享路由或其他 IDE 配置。

## 5. 添加模型页面

### 5.1 页面结构

复用 CodeBuddy 的供应商选择心智与 Devin / Windsurf 的工作区风格：

- 顶部：返回、标题、取消、`添加到 Cursor（N）`；
- 左侧：供应商搜索与列表；
- 右侧上部：模型搜索、全选/全不选和所选供应商的模型多选列表；
- 已添加模型显示“已添加”，默认不重复创建绑定；
- 右侧下部：添加设置；
- 页面底部：折叠的高级选项。

### 5.2 默认小白流程

```text
选择供应商
→ 勾选模型
→ 点击“添加到 Cursor”
```

系统自动完成：

- 查找或创建共享模型路由；
- 生成唯一 Cursor 模型 ID；
- 默认沿用模型原名；
- 自动识别 Agent、Thinking、Vision；
- 自动选择上游协议；
- 默认启用；
- 保存 Cursor 平台配置；
- Core 运行时自动热同步；
- Core 未运行时标记为待同步。

默认页面不出现 API Key、Base URL、底层协议字段和请求路径。

### 5.3 基础设置

添加页默认只展示一行只读摘要，不增加操作步骤：

- 使用模型原名；
- 自动识别能力；
- 自动选择协议；
- 保存后自动同步。

需要修改命名或平台参数的用户可展开“高级选项”，或在添加完成后进入单模型编辑页。批量添加时不要求逐个编辑显示名和模型 ID。

### 5.4 能力策略

能力使用“自动识别”为默认策略，而不是要求小白配置多个开关。

能力来源：

- 供应商全局能力；
- 供应商模型级能力；
- 保守的模型族识别。

首版能力策略：

- 添加页只展示自动识别结果，不提供逐项开关；
- 能力信息用于帮助用户理解兼容性，不承诺未被 Core 消费的行为；
- `reasoning` 可映射到 Core 的推理配置；
- Agent、Vision、Stream 只有在后端协议链路具备真实消费逻辑后，才允许在编辑页提供覆盖；
- 未实现消费逻辑的能力只读展示，不做假开关。

不能默认声明上游明确不支持的能力。

### 5.5 高级选项

标题：`高级选项 · 一般无需修改`

添加页只提供本批次的 Cursor 专属命名设置：

- 使用模型原名；
- 统一增加 `(BYOK)` 后缀；
- 自定义统一前缀或后缀。

不在批量添加页编辑故障转移、请求头、参数覆盖等共享路由设置。系统为没有共享路由的供应商模型创建默认路由，专业用户可在添加完成后通过单模型编辑页进入统一路由编辑器。

API Key 和 Base URL 始终由供应商页面管理，不在 Cursor 页面重复提供。

## 6. 编辑模型页面

复用现有平台编辑页面的布局，支持：

- 修改 Cursor 显示名和模型 ID；
- 更换绑定的统一模型路由；
- 启用/停用；
- 设置推理强度、上下文窗口和最大输出 Token；
- 查看自动识别的 Agent、Thinking、Vision 兼容性；
- 通过“编辑共享路由”跳转到现有统一代理模型编辑器，并明确提示该修改可能影响其他 IDE；
- 从 Cursor 移除。

第二阶段增加“复制为新的 Cursor 配置”和真实模型测试。真实测试接口未实现前不展示可点击的测速按钮，不允许使用随机延迟模拟成功。

## 7. 内部数据边界

### 7.1 供应商层

唯一维护：

- API Key；
- Base URL；
- 模型目录；
- 供应商能力；
- 模型级能力。

### 7.2 共享模型路由层

维护跨 IDE 可复用的上游路由。共享路由必须增加不可变的 `uid`；现有 `id` 继续作为对外模型 ID，允许用户改名，但平台绑定不依赖可变的 `id`。

```json
{
  "uid": "route-01JXYZ...",
  "id": "claude-opus-4.1",
  "targets": [
    {
      "providerId": "openrouter",
      "model": "anthropic/claude-opus-4.1",
      "apiFormat": "anthropic"
    }
  ],
  "capabilities": {
    "stream": true,
    "tools": true,
    "vision": true,
    "reasoning": true
  },
  "enhancement": {
    "retry": true,
    "autoRouting": true
  }
}
```

共享路由不保存某个 IDE 的显示名称、排序和启用状态。

### 7.3 Cursor 平台绑定层

独立保存 Cursor 特有配置：

```json
{
  "version": 1,
  "revision": "content-hash",
  "models": [
    {
      "id": "cursor-01JXYZ...",
      "routeUid": "route-01JXYZ...",
      "displayName": "Claude Opus 4.1",
      "exposedModelId": "claude-opus-4.1",
      "enabled": true,
      "sortOrder": 1,
      "capabilityPolicy": "auto",
      "capabilityOverrides": {},
      "cursorOverrides": {
        "reasoningEffort": null,
        "contextWindowTokens": null,
        "maxCompletionTokens": null
      }
    }
  ]
}
```

保存到配置目录的 `cursor-models.json`。它只保存平台绑定，不保存供应商密钥。

### 7.4 避免架构过重

平台绑定层只在内部存在。小白添加模型时：

1. 如果相同供应商/模型已有共享路由，直接复用；
2. 如果没有，后台自动创建默认共享路由；
3. 自动创建 Cursor 绑定；
4. 用户不需要先进入代理模型页面；
5. 添加页以轻量说明告知：尚无共享路由时会自动加入 AnyBridge 统一模型池，后续可被其他 IDE 复用。

首版不建设通用数据库或通用 IDE Binding 框架，只实现边界清晰的 Cursor 绑定文件；待第二个平台有相同需求时再抽象公共层。

## 8. Cursor Core 数据转换

Cursor Core 不再直接把全部 `proxy-routes.json` OpenAI 路由当作 Cursor 模型。

同步流程：

```text
读取 cursor-models.json
→ 过滤 enabled 的 Cursor 绑定
→ 按 routeUid 关联 proxy-routes.json
→ 校验共享路由存在且可用
→ 生成 Cursor Core 模型配置
→ 原子替换 Core 模型目录
```

转换字段：

- `displayName` → Core `display_name`；
- `exposedModelId` → Core `model_id`；
- 共享路由仍通过 AnyBridge 本地网关调用；
- Cursor 专属上下文和推理覆盖进入 Core 模型配置；
- 供应商 API Key 不写入 Cursor Core 模型目录。

现有“读取全部 OpenAI 路由”的行为只作为旧配置迁移来源，迁移完成后不再作为正常运行路径。

## 9. 旧配置兼容

首次读取时如果 `cursor-models.json` 不存在：

1. 从现有启用且暴露 OpenAI 的代理路由生成 Cursor 绑定；
2. 保留原路由，不修改其他 IDE；
3. 写入 `cursor-models.json`；
4. 记录迁移版本，后续不重复导入；
5. 首次迁移后显示一次性说明，告知已从现有统一模型池导入多少个 Cursor 模型；
6. 用户可在 Cursor 页面移除不需要的绑定。

这保证现有用户升级后不会突然丢失 Cursor 模型，也不会因静默导入而误解模型来源。

## 10. 保存与同步状态

### 10.1 保存流程

```text
选择供应商模型
→ 获取进程内配置写锁
→ 读取并校验最新共享路由与 Cursor 绑定
→ 在内存中创建/复用共享路由和 Cursor 绑定
→ 先写临时文件并完成反序列化校验
→ 原子替换共享路由文件
→ 原子替换 Cursor 绑定文件
→ 第二步失败时使用同一写锁回滚共享路由文件
→ 释放写锁
→ Core 未运行：返回 pending
→ Core 运行：执行热同步
→ 返回批次结果
```

同一批次添加采用全有或全无语义，不返回部分成功。共享路由或绑定任一保存失败时，配置恢复到操作前版本。

如果绑定保存成功但同步失败：

- 保留配置；
- 标记待同步或同步失败；
- 显示可理解的错误；
- 提供重新同步；
- 不要求用户重复添加。

### 10.2 同步状态模型

`cursor_get_status` 增加：

```json
{
  "configRevision": "hash-a",
  "coreRevision": "hash-a",
  "syncState": "synced",
  "lastSyncAt": 1788680000000,
  "lastSyncError": null,
  "configuredModels": 3,
  "syncedModels": 3
}
```

状态含义：

- `synced`：配置修订与 Core 修订一致；
- `pending`：Core 未运行或配置尚未同步；
- `error`：最近同步失败；
- `empty`：没有 Cursor 模型。

同步状态由后端提供，前端不自行推测。

## 11. 后端接口

### 生命周期

- `cursor_get_status`
- `cursor_preflight`
- `cursor_enable`
- `cursor_disable`
- `cursor_restart`
- `cursor_sync_routes`

### Cursor 模型绑定（首版闭环）

- `cursor_list_models`
- `cursor_list_provider_models`
- `cursor_add_models`
- `cursor_update_model`
- `cursor_remove_models`
- `cursor_set_models_enabled`

`cursor_duplicate_model` 属于后续增强，不阻塞首版小白接入闭环。

`cursor_list_provider_models` 可复用现有供应商目录实现，但返回值不得向前端泄露 API Key。现有通用 `list_provider_models` 包含 `apiKey`，Cursor 页面不应直接使用该敏感返回结构。

### 测试（第二阶段）

- `cursor_test_model`

返回真实结果：连接状态、首包时间、协议错误、模型错误。它不阻塞首版模型添加和同步闭环；接口完成前，前端不展示测试操作。

## 12. 安全边界

- 不展示、记录或返回 `LOCAL_PROXY_KEY`；
- Cursor 模型目录不保存供应商真实 API Key；
- Cursor 添加模型接口不向前端返回供应商 API Key；
- 不读取、修改或伪造 Cursor Access Token；
- 不出现“Pro / Ultra 解锁”；
- 官方模型继续走 Cursor 官方服务；
- 停止接入时精确恢复原始代理配置。

## 13. 错误处理

- 供应商无模型：提示先在供应商页面获取或添加模型；
- 重复选择：显示已添加，不重复创建默认绑定；
- 模型 ID 冲突：自动生成唯一 ID，并允许在高级选项中修改；
- 共享路由丢失：主列表显示“配置异常”，提供修复或重新选择；
- 保存失败：回滚内存状态并留在当前页面；
- 同步失败：保留配置并显示待同步/失败；
- Core 未运行：保存成功，状态为待同步；
- 旧配置迁移失败：保留旧文件，不覆盖，返回可诊断错误。

## 14. 验收标准

1. 供应商 API Key 和 Base URL 只配置一次。
2. Cursor 默认添加流程只有“选择供应商—勾选模型—确认添加”。
3. 页面布局、工具栏、表格密度、按钮和添加模型流程与现有 IDE 控制台同构。
4. Cursor 使用“模型列表/添加模型”，不出现槽位映射语义。
5. 添加 Cursor 模型不会删除或修改其他 IDE 的平台配置。
6. 删除 Cursor 模型只删除 Cursor 绑定。
7. 未有共享路由时后台自动创建，用户无需先去代理页面。
8. Core 只同步 Cursor 绑定中启用的模型，不再同步全部 OpenAI 路由。
9. 同步状态来自后端修订信息，不由前端猜测。
10. 旧版已有模型首次升级后自动迁移，不丢失。
11. Cursor 页面只编辑平台专属设置；共享路由通过明确入口跳转统一代理模型编辑器。
12. 没有真实测试接口前不显示虚假测速。
13. Cursor Core 和前端都不获得供应商真实 API Key。
14. 深色与浅色主题、窗口最小宽度下均可使用。
