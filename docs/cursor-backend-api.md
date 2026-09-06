# Cursor 后端接口（Gemini 前端对接）

本文件仅描述前端可调用的 Tauri 命令。Cursor 页面可完全独立实现，不应再调用旧的 `switch_ide_to_proxy({ target: "cursor" })`、`cursorAuth` 字符串状态或 Node `cursor-proxy.js`。

## 命令

### `cursor_get_status`

无参数。返回：

```json
{
  "running": false,
  "controlPort": 17650,
  "healthUrl": "http://127.0.0.1:17650/__byok-api__/healthz",
  "configuredModels": 3,
  "certificateReady": true,
  "certificateMessage": "AnyBridge CA 已安装到 CurrentUser\\Root",
  "availableActions": ["enable", "repair"],
  "lastError": null
}
```

### `cursor_preflight`

无参数。检查：

- Cursor Core 开发/安装二进制存在；
- 至少一个启用且暴露 OpenAI 格式的代理模型；
- AnyBridge 本地代理 Key 已生成。

成功返回同 `cursor_get_status`，失败直接返回可显示的中文错误字符串。

### `cursor_enable`

无参数。行为：

1. 确保 AnyBridge 本地模型网关运行；
2. 启动 Cursor Core；
3. 同步 `proxy-routes.json`；
4. 使用 AnyBridge 已有 CA；
5. 写入 Cursor 本地代理配置；
6. 不修改 Cursor 登录 Token 或订阅权益。

成功返回状态对象。首次启用后前端应提示用户重启 Cursor 并新建对话。

### `cursor_sync_routes`

无参数。Cursor Core 运行时将最新 `proxy-routes.json` 原子同步到模型目录，无需重启 Core。保存代理模型后调用。

### `cursor_disable`

无参数。先要求 Core 恢复 Cursor 原配置，再停止 Core。首次启用前保存的 `http.proxy`、`http.noProxy` 等用户原值会被精确恢复。

### `cursor_restart`

无参数。重启 Cursor Core 并重新同步模型路由。它不会重启 Cursor IDE；需要重启 IDE 时继续调用现有 `restart_ide({ target: "cursor" })`。

## 模型管理命令

### `cursor_list_models`
无参数。返回 Cursor 平台的模型绑定组合视图列表，用于主表格渲染：
- `id`: 绑定唯一 ID
- `routeUid`: 关联的共享路由 UID
- `displayName`: Cursor 显示名称
- `exposedModelId`: 暴露到 Cursor 的模型标识
- `enabled`: 是否启用
- `providerName`: 所属供应商显示名
- `targetModel`: 上游真实模型标识
- `supportsTools` / `supportsReasoning` / `supportsVision`: 能力标识

### `cursor_list_provider_models`
无参数。返回安全供应商模型树，用于“添加模型”页面：
- 仅返回供应商 ID、名称与模型列表，已自动过滤并剔除 API Key 等敏感凭据；
- 包含 `alreadyAdded` 与已有绑定 ID 标记。

### `cursor_add_models`
参数 `{ req: { models: [{ providerId, modelId, displayName }] } }`。
批量添加模型到 Cursor：自动复用或创建共享路由并建立 Cursor 专有绑定。

### `cursor_update_model`
参数 `{ req: { id, displayName, reasoningEffort, contextWindowTokens, maxCompletionTokens } }`。
更新指定 Cursor 模型的专有参数。

### `cursor_remove_models`
参数 `{ req: { ids: string[] } }`。
批量从 Cursor 移除模型绑定，**不影响共享路由及其他 IDE 平台**。

### `cursor_set_models_enabled`
参数 `{ req: { ids: string[], enabled: boolean } }`。
批量启用或停用 Cursor 模型。

## 页面状态建议

- `running=false && configuredModels=0`：显示“先添加模型”。
- `running=false && configuredModels>0`：主按钮“启动接入”。
- `running=true`：主按钮“重启 Cursor”，次按钮“同步模型”“停止接入”。
- 操作按钮以 `availableActions` 为准，不自行推测后台状态。

## 安全边界

- 不展示或记录 `LOCAL_PROXY_KEY`；
- 不读取或修改 Cursor Access Token；
- 不展示“Pro/Ultra 解锁”字样；
- 官方模型和官方账号请求继续由 Cursor 官方服务处理；
- 本地模型 ID 来源于 AnyBridge 代理模型路由。
