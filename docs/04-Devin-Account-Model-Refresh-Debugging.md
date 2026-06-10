---
title: Devin 当前账号模型与额度刷新调试记录
---

# Devin 当前账号模型与额度刷新调试记录

## 结论

- **查询接口**：`GetUserStatus`
  - `https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetUserStatus`
- **请求 metadata**：即使读取的是 Devin 的 `state.vscdb`，也必须按 `windsurf-pool` 的方式固定使用：
  - `ideName: "windsurf"`
  - `extensionName: "windsurf-next"`
  - `ideVersion: "0.0.0"`
  - `extensionVersion: "1.0.0"`
  - `locale: "en"`
- **账号信息来源**：不要从缓存判断当前账号，必须用有效 `devin-session-token$...` 调 `GetUserStatus`，以 API 返回的 `userStatus.email` 为准。
- **模型列表路径**：`/userStatus/cascadeModelConfigData/clientModelConfigs`
- **刷新返回值约束**：`refresh_ide_models` 返回给 UI 的 `models` 必须保持本次 `GetUserStatus` 实时返回的当前账号模型；缓存可以合并内置/历史槽位，但不能回填污染刷新结果。
- **套餐/额度路径**：
  - `planName`: `/userStatus/planStatus/planInfo/planName`（兼容 `/planInfo/planName`）
  - `dailyQuotaRemainingPercent`: `/userStatus/planStatus/dailyQuotaRemainingPercent`
  - `weeklyQuotaRemainingPercent`: `/userStatus/planStatus/weeklyQuotaRemainingPercent`
  - `overageBalanceMicros`: `/userStatus/planStatus/overageBalanceMicros`

## 本次实测

当前 Devin 账号：`kjtrkxi31562@gmail.com`

从 `C:\Users\admin\AppData\Roaming\Devin\User\globalStorage\state.vscdb` 中实测发现：

- **第一个** `apiKey` 匹配到的 token 长度为 `169`，调用 `GetUserStatus` 返回 `401 Invalid token`。
- **最后一个** `apiKey` 匹配到的 token 长度为 `189`，调用 `GetUserStatus` 成功返回 `200`。
- API 成功返回：
  - `email`: `kjtrkxi31562@gmail.com`
  - `teamsTier`: `TEAMS_TIER_DEVIN_TRIAL`
  - `planName`: `Trial`
  - `dailyQuotaRemainingPercent`: `100`
  - `weeklyQuotaRemainingPercent`: `100`
  - `overageBalanceMicros`: `183469881`
  - `clientModelConfigs`: `10` 个模型

## 避免再次犯错

- **不要只取第一个 regex match**：`state.vscdb` 里会保留多个历史/截断 token，第一个可能无效。应取同字段的最后一个匹配。
- **不要把 Devin metadata 改成 Devin**：`windsurf-pool` 实测可用的 `GetUserStatus` 调用固定使用 `ideName = "windsurf"` 与 `extensionName = "windsurf-next"`。
- **不要用缓存当真实来源**：缓存只能兜底展示，刷新时必须以 `GetUserStatus` 返回为准。
- **不要从错误路径读取模型**：当前有效模型在 `/userStatus/cascadeModelConfigData/clientModelConfigs`，不是 `/userStatus/clientModelConfigs`。
- **修改前先跑最小验证**：先用当前账号 token 调 `GetUserStatus` 验证 `200`、账号 email、额度字段、模型数量，再改 Rust 后端。

## 模型映射与解锁排查结论

- **模型映射主表显示策略**：主表应分为三档：
  - `已映射`：只显示已配置 BYOK 映射的槽位。
  - `+ 官方`：显示已映射槽位 + 当前账号 API 实际返回的官方可用模型。
  - `全部模型`：显示已映射槽位 + 官方模型 + 内置扩展模型；扩展且未映射的模型标记为「未配置」。
- **未授权模型解锁**：`Claude Opus 4.6` 这类试用账号原本不可选的模型，不能只依赖当前账号返回列表；UI 必须允许从内置扩展槽位添加映射，sidecar 的 `GetUserStatus` 改写负责删除 disabled 字段并让该槽位出现在 IDE 下拉框。
- **映射不生效常见原因**：
  - IDE 没重启，仍使用启动前缓存的模型列表或旧代理配置。
  - 目标 IDE 选错，例如写入了 Windsurf 的 `settings.json`，但用户实际在 Devin 中测试。
  - IDE `settings.json` 没有指向 `http://localhost:7450` 或 `http.proxyStrictSSL` 不是 `false`。
  - sidecar 没读到同一份 `model-map.json` / `providers.json`；启动时必须通过 `BYOK_CONFIG_DIR` 指向 GUI 的配置目录。
  - 打包资源目录传错会导致 sidecar 找不到 `windsurf-catalog.json` / `byok-cards.js`，进而表现为槽位解锁、卡片显示或诊断能力异常。
- **安装目录影响判断**：自定义安装目录通常不影响用户配置目录；真正影响的是 Tauri 传给 sidecar 的 `BYOK_RESOURCE_DIR` 是否是资源根目录，以及当前目标 IDE 的用户配置路径是否写对。
