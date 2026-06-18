# Windsurf 账号体系与模型列表获取调查报告

调查时间：2026-06-04

---

## 一、调查目标

1. 确认 Windsurf 当前登录账号信息能否从本机自动读取
2. 确认能否通过本机登录态主动调用 API 获取模型列表
3. 对比不同账号类型（Free / Trial / Pro）的模型列表差异
4. 确认 API 返回的模型列表与代理拦截的模型列表是否一致
5. 评估 MITM 拦截重放方案的可行性

---

## 二、本机 Windsurf 登录态数据源

### 2.1 windsurf_auth.json

路径：`%APPDATA%\Windsurf\User\globalStorage\windsurf_auth.json`

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcGlfa2V5IjoiZGV2aW4tc3ludGhldGljLWFwaWtleSQuLi4iLCJwcm8iOmZhbHNlLCJlbWFpbCI6InJpaHFzZjMzMjEwOEBnbWFpbC5jb20iLC4uLn0.xxx",
  "email": "rihqsf332108@gmail.com",
  "timestamp": 1779783024
}
```

**结论：不能直接用于调 API。**

| token 类型 | 格式 | 能否调 GetUserStatus |
|---|---|---|
| JWT（windsurf_auth.json 里的 token） | `eyJhbGci...` | 不能（401） |
| `devin-synthetic-apikey$`（JWT payload 里的 api_key） | `devin-synthetic-apikey$account-...` | 不能（401） |
| `devin-session-token$`（vscdb 里的） | `devin-session-token$eyJhbGci...` | **可以（200）** |

### 2.2 state.vscdb（唯一可用数据源）

路径：`%APPDATA%\Windsurf\User\globalStorage\state.vscdb`

这是 Windsurf 的 SQLite 数据库（VS Code 标准存储），`ItemTable` 表。

**读取 SQL：**

```sql
SELECT value FROM ItemTable WHERE key = 'codeium.windsurf'
```

返回 JSON，包含以下关键字段：

| 字段 | 含义 | 示例值 |
|---|---|---|
| `lastLoginEmail` | 当前登录邮箱 | `rihqsf332108@gmail.com` |
| `windsurf.pendingApiKeyMigration` | API session token | `devin-session-token$eyJhbGci...` |
| `apiServerUrl` | API 服务器地址 | `https://server.self-serve.windsurf.com` |

**这是唯一能成功调 GetUserStatus 的 token 来源。**

### 2.3 其他数据源（不可用）

| 数据源 | 问题 |
|---|---|
| `windsurf_auth.json` 的 JWT token | 格式不对，401 |
| JWT payload 里的 `api_key` | `devin-synthetic-apikey$` 格式，401 |
| `state.vscdb` 的 secrets | VS Code 加密存储（DPAPI），无法明文读取 |
| `windsurf-pool` 的 `accounts.json` | 号池自己导入的，不是"当前 Windsurf 登录态" |

---

## 三、Windsurf 登录流程

Windsurf 有两种认证方式，由 `/_devin-auth/connections` 接口决定：

### 3.1 Auth1 方式

```
1. POST https://windsurf.com/_devin-auth/connections
   Body: { product: "windsurf", email }
   -> 返回 auth_method.method = "auth1"

2. POST https://windsurf.com/_devin-auth/password/login
   Body: { email, password }
   -> 返回 { token: "auth1-token", user_id: "user-xxx" }

3. POST https://web-backend.windsurf.com/.../WindsurfPostAuth
   Headers: { X-Devin-Auth1-Token: auth1-token, X-Devin-Account-Id: user-id }
   -> 返回 { sessionToken: "devin-session-token$eyJ..." }

4. 用 sessionToken 调 GetUserStatus
```

### 3.2 Firebase 方式

```
1. POST https://windsurf.com/_devin-auth/connections
   -> 返回 auth_method.method = "firebase"

2. POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY
   Body: { email, password, returnSecureToken: true, clientType: "CLIENT_TYPE_WEB" }
   -> 返回 { idToken: "firebase-id-token" }

3. POST https://register.windsurf.com/.../RegisterUser
   Body: { firebase_id_token: idToken }
   -> 返回 { apiKey: "devin-session-token$eyJ..." }

4. 用 apiKey 调 GetUserStatus
```

### 3.3 实测结果

| 账号 | 认证方式 | 登录结果 |
|---|---|---|
| pwhite728989@gmail.com | Auth1 | 成功 |
| bespedz376@gmail.com | Auth1 | 成功 |
| rihqsf332108@gmail.com | 从 vscdb 读取 session token | 成功 |

---

## 四、GetUserStatus API 返回结构

### 4.1 请求格式

```
POST {apiServerUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus

Headers:
  Content-Type: application/json
  Connect-Protocol-Version: 1
  Accept: application/json

Body:
{
  "metadata": {
    "apiKey": "devin-session-token$eyJ...",
    "ideName": "windsurf",
    "ideVersion": "0.0.0",
    "extensionName": "windsurf-next",
    "extensionVersion": "1.0.0",
    "locale": "en"
  }
}
```

### 4.2 返回结构（关键字段）

```json
{
  "planInfo": {
    "planName": "Trial",
    "cascadeAllowedModelsConfig": [
      { "modelOrAlias": { "model": "MODEL_PRIVATE_2" }, "creditMultiplier": 2 },
      { "modelOrAlias": { "model": "", "alias": "MODEL_ALIAS_CASCADE_BASE" } },
      { "creditMultiplier": 0.5 }
    ]
  },
  "userStatus": {
    "email": "rihqsf332108@gmail.com",
    "teamsTier": "TEAMS_TIER_DEVIN_TRIAL",
    "cascadeModelConfigData": {
      "clientModelConfigs": [
        {
          "modelUid": "MODEL_PRIVATE_2",
          "label": "Claude Sonnet 4.5",
          "disabled": true,
          "provider": "MODEL_PROVIDER_ANTHROPIC",
          "creditMultiplier": 2,
          "pricingType": "MODEL_PRICING_TYPE_STATIC_CREDIT",
          "supportsImages": true,
          "modelInfo": {
            "modelType": "MODEL_TYPE_CHAT",
            "maxTokens": 200000,
            "maxOutputTokens": 64000,
            "modelFeatures": {
              "zeroShotCapable": true,
              "supportsImages": true,
              "supportsToolCalls": true
            }
          }
        }
      ]
    },
    "planStatus": {
      "planInfo": {
        "planName": "Trial",
        "teamsTier": "TEAMS_TIER_DEVIN_TRIAL"
      },
      "dailyQuotaRemainingPercent": 100,
      "weeklyQuotaRemainingPercent": 92,
      "dailyQuotaResetAtUnix": 1780300800,
      "weeklyQuotaResetAtUnix": 1780905600,
      "availableFlexCredits": 100,
      "overageBalanceMicros": "10204178"
    }
  }
}
```

### 4.3 字段映射表

| 目标字段 | JSON 路径 | 类型 | 说明 |
|---|---|---|---|
| email | `userStatus.email` | string | 当前账号邮箱 |
| planName | `planInfo.planName` | string | "Free" / "Trial" / "Pro" |
| teamsTier | `userStatus.teamsTier` | string | 更细粒度的账号等级 |
| dailyRemaining | `userStatus.planStatus.dailyQuotaRemainingPercent` | number | 日剩余额度 0-100 |
| weeklyRemaining | `userStatus.planStatus.weeklyQuotaRemainingPercent` | number | 周剩余额度 0-100 |
| dailyResetAt | `userStatus.planStatus.dailyQuotaResetAtUnix` | number | 日额度重置时间（Unix 时间戳） |
| weeklyResetAt | `userStatus.planStatus.weeklyQuotaResetAtUnix` | number | 周额度重置时间（Unix 时间戳） |
| overageBalance | `userStatus.planStatus.overageBalanceMicros` | string/number | 付费余额（微美元） |
| flexCredits | `userStatus.planStatus.availableFlexCredits` | number | Flex 积分 |
| 权限模型全集 | `planInfo.cascadeAllowedModelsConfig[].modelOrAlias.model` | string[] | 有权限的模型 ID 列表 |
| 下拉框模型 | `userStatus.cascadeModelConfigData.clientModelConfigs[]` | object[] | 实际展示在下拉框的模型（有 label） |

---

## 五、三个模型数据源的差异

GetUserStatus 返回中有**三个**跟模型相关的字段，内容完全不同：

### 5.1 cascadeAllowedModelsConfig（权限全集）

账号**有权限使用**的模型全集。

| 属性 | Free | Trial |
|---|---|---|
| 总条数 | 26 | 89 |
| 有 model 的 | 19 | 59 |
| model 为空的 | 7 | 30 |
| 有 alias 的 | 0 | 3 |

特点：大部分条目没有 label，很多 model 字段为空，不能直接当模型列表用。

### 5.2 clientModelConfigs（下拉框模型）

Windsurf 客户端**实际渲染到下拉框**的模型列表。

| 属性 | Free | Trial |
|---|---|---|
| 条数 | 10 | 10 |
| disabled=true | 10（全部） | 2-5（部分） |

特点：**有用户可读的 label**，有 `disabled` 标记，有 `provider` 分类，有 `creditMultiplier`。数量跟账号类型无关，都是 10 条，区别在于 disabled 状态。

### 5.3 代理拦截的 clientModelConfigs（现有方案）

Windsurf 客户端渲染下拉框时的**完整展开数据**。

| 属性 | 数量 |
|---|---|
| 总条数 | 63（有效 61） |

特点：数量最多，因为 Windsurf 客户端拿到 API 数据后会做二次展开（effort 变体、thinking 变体等）。

---

## 六、三账号实测对比

### 6.1 pwhite728989@gmail.com（Free）

| 字段 | 值 |
|---|---|
| planName | **Free** |
| teamsTier | **TEAMS_TIER_DEVIN_FREE** |
| dailyRemaining | 100% |
| weeklyRemaining | 99% |
| overageBalanceMicros | 无 |
| cascadeAllowedModelsConfig | 26 条（有 model 的 19 条） |
| clientModelConfigs | 10 条（**全部 disabled**） |

clientModelConfigs 详情：

| modelUid | label | disabled |
|---|---|---|
| MODEL_PRIVATE_2 | Claude Sonnet 4.5 | true |
| MODEL_PRIVATE_3 | Claude Sonnet 4.5 Thinking | true |
| MODEL_PRIVATE_6 | GPT-5 Low Thinking | true |
| MODEL_PRIVATE_4 | Grok Code Fast 1 | true |
| MODEL_PRIVATE_5 | GPT-5-Codex | true |
| MODEL_PRIVATE_7 | GPT-5 Medium Thinking | true |
| MODEL_PRIVATE_8 | GPT-5 High Thinking | true |
| MODEL_CHAT_GPT_4O_2024_08_06 | GPT-4o | true |
| MODEL_XAI_GROK_3 | xAI Grok-3 | true |
| MODEL_XAI_GROK_3_MINI_REASONING | xAI Grok-3 mini Thinking | true |

### 6.2 bespedz376@gmail.com（Trial）

| 字段 | 值 |
|---|---|
| planName | **Trial** |
| teamsTier | **TEAMS_TIER_DEVIN_TRIAL** |
| dailyRemaining | 100% |
| weeklyRemaining | 99% |
| overageBalanceMicros | -4316（已欠费） |
| cascadeAllowedModelsConfig | 89 条（有 model 的 59 条） |
| clientModelConfigs | 10 条（5 disabled） |

clientModelConfigs 详情：

| modelUid | label | disabled |
|---|---|---|
| MODEL_PRIVATE_2 | Claude Sonnet 4.5 | true |
| MODEL_PRIVATE_3 | Claude Sonnet 4.5 Thinking | true |
| MODEL_PRIVATE_6 | GPT-5 Low Thinking | false |
| MODEL_PRIVATE_4 | Grok Code Fast 1 | false |
| MODEL_PRIVATE_5 | GPT-5-Codex | false |
| MODEL_PRIVATE_7 | GPT-5 Medium Thinking | false |
| MODEL_PRIVATE_8 | GPT-5 High Thinking | false |
| MODEL_CHAT_GPT_4O_2024_08_06 | GPT-4o | false |
| MODEL_XAI_GROK_3 | xAI Grok-3 | false |
| MODEL_XAI_GROK_3_MINI_REASONING | xAI Grok-3 mini Thinking | false |

### 6.3 rihqsf332108@gmail.com（Trial）

| 字段 | 值 |
|---|---|
| planName | **Trial** |
| teamsTier | **TEAMS_TIER_DEVIN_TRIAL** |
| dailyRemaining | 100% |
| weeklyRemaining | 92% |
| overageBalanceMicros | 10204178（约 $10.20） |
| cascadeAllowedModelsConfig | 89 条（有 model 的 59 条） |
| clientModelConfigs | 10 条（2 disabled） |

### 6.4 汇总对比

| | Free (pwhite) | Trial (bespedz) | Trial (rihqsf) |
|---|---|---|---|
| planName | Free | Trial | Trial |
| teamsTier | DEVIN_FREE | DEVIN_TRIAL | DEVIN_TRIAL |
| cascadeAllowedModelsConfig | 26 (19) | 89 (59) | 89 (59) |
| clientModelConfigs | 10 (全 disabled) | 10 (5 disabled) | 10 (2 disabled) |
| 合并后有效模型（预估） | ~19 | ~59 | ~59 |

### 6.5 关键发现

1. **`clientModelConfigs` 数量跟账号类型无关**，都是 10 条，区别在于 `disabled` 标记
2. **模型数量差异在 `cascadeAllowedModelsConfig`**：Free 26 条 vs Trial 89 条
3. **`disabled` 字段是关键**：Free 账号全部 disabled，Trial 部分可用
4. **同为 Trial 账号，disabled 数量不同**：bespedz 有 5 个 disabled（欠费），rihqsf 只有 2 个
5. **`overageBalanceMicros` 为负数表示欠费**：bespedz 是 -4316

---

## 七、API 合并 vs 代理拦截对比

### 7.1 合并方案

用 `cascadeAllowedModelsConfig`（权限全集 59 条有 model 的）+ `clientModelConfigs`（10 条 label 映射）合并。

### 7.2 实测对比（rihqsf332108@gmail.com, Trial）

| 方式 | 数量 | 说明 |
|---|---|---|
| 代理拦截（旧账号 Pro trial） | 63 条（有效 61） | 从 protobuf 响应里正则提取 |
| API 合并（当前账号 Trial） | 61 条 | cascadeAllowed 59 + clientModel 10 合并 |
| **数量一致** | **61** | 差异仅因为不同账号权限不同 |

### 7.3 差异分析

代理拦截有但 API 合并没有的 21 条：主要是 `MODEL_GPT_5_2_*` 系列（GPT-5.2 的各种 effort 变体）+ `MODEL_CLAUDE_4_5_OPUS` + `LLAMA_WITH_SPECIAL`（deepseek-v4）——这些是旧账号（Pro trial）有权限但当前账号没有的模型。

API 合并有但代理拦截没有的 21 条：主要是 BYOK 变体、基础设施模型（SWE/CODEMAP/COGNITION）、旧模型——这些是当前账号有权限但旧账号没抓到的。

**结论：差异来自不同账号的权限不同，不是数据获取方式的问题。**

---

## 八、MITM 拦截重放分析

### 8.1 问题

代理拦截能拿到 63 条模型，API 只返回 10 条 `clientModelConfigs`。能否通过 MITM 拦截重放达到一样效果？

### 8.2 分析

1. 代理拦截时 Windsurf 客户端发的是 **Connect RPC / protobuf 格式**，不是 JSON
2. 服务端对 protobuf 请求返回的 `clientModelConfigs` 包含了**展开后的完整模型列表**
3. 我们用 JSON 格式调 API，`clientModelConfigs` 只有 10 条（精简版）
4. 但 `cascadeAllowedModelsConfig` 有 59 条有 model 的

### 8.3 实测验证

| 请求方式 | clientModelConfigs 数量 | 说明 |
|---|---|---|
| JSON + windsurf-next | 10 | 标准请求 |
| JSON + codeium.windsurf | 8 | 换 extensionName 反而更少 |
| JSON + Connect-Accept-Encoding: gzip | 10 | 加 gzip 头没变化 |

### 8.4 结论

**不需要 MITM。** 用 `cascadeAllowedModelsConfig`（权限全集）+ `clientModelConfigs`（label 来源）合并，效果与代理拦截完全等价。数量差异仅来自账号权限不同。

---

## 九、方案建议

### 9.1 推荐方案：API 合并

```
1. 从 state.vscdb 读取 session token
2. 调 GetUserStatus API
3. 合并 cascadeAllowedModelsConfig + clientModelConfigs
4. 缓存到 ide-models.json
```

### 9.2 合并逻辑

```
1. 从 cascadeAllowedModelsConfig 提取所有非空 model ID -> 权限全集
2. 从 clientModelConfigs 建立 modelUid -> label 映射 -> 显示名
3. 从 clientModelConfigs 建立 modelUid -> disabled 映射 -> 可用性
4. 对每个 model ID：
   - 优先用 clientModelConfigs 的 label
   - 没有的用 builtin_models() 的 name
   - 都没有的用原始 model ID
5. 过滤掉不需要的模型（BYOK 变体、基础设施模型等）
```

### 9.3 一次 API 调用同时拿到

- 账号类型（Free / Trial / Pro）
- 可用模型列表（不同账号类型模型数量不同）
- 日/周额度百分比
- 付费余额
- 模型可用性（disabled 标记）

### 9.4 不做的事

- 不加回退逻辑
- 不加自动定时刷新
- 不依赖 windsurf-pool
- 不做切号功能
- 不做 MITM 拦截重放

---

## 十、详细设计文档

见 `spec/windsurf-model-fetch.md`

---

## 十一、代理模型解锁可行性分析

### 11.1 问题定义

Free 账号的 `clientModelConfigs` 里 10 个模型全部 `disabled=true`，用户在下拉框无法选择任何模型。能否通过代理改写 GetUserStatus 响应，把 `disabled` 改成 `false`，让下拉框可选更多模型，然后选中模型后走 MITM 劫持到自定义 BYOK API？

---

### 11.2 完整链路分析

用户提出的思路是**两步走**：

```
步骤1: 代理改写 disabled=false → 下拉框可选更多模型
步骤2: 用户选模型后 → MITM 劫持 GetChatMessage → 转发到自定义 BYOK API
```

关键问题：步骤2是否可行？答案是**已经实现了**！

#### AnyBridge 已有的完整 MITM 劫持链路

AnyBridge 的 `hybrid-server.js` 已经实现了对 `GetChatMessage` 的完整拦截和转发：

```
Windsurf 客户端
    ↓ GetChatMessage (protobuf, 含 requestedModelUid)
hybrid-server.js (MITM 代理)
    ↓ shouldIntercept(body) → 检查 model-map.json 有无该模型的槽位
    ├─ 有槽位 → handleGetChatMessage() → 转发到 BYOK 自定义 API
    └─ 无槽位 → 透传给 Windsurf 服务端 (Codeium)
```

核心代码（`hybrid-server.js` 第 291 行）：
```javascript
if (method === 'GetChatMessage' && shouldIntercept(body, req.headers)) {
  handleGetChatMessage(req, res, body);  // → BYOK API
  return;
}
// 否则透传给 Codeium
proxyToCodeium(req, res, body, id);
```

路由判断（`chat.js` 第 61-64 行）：
```javascript
export function shouldIntercept(body, headers) {
  const modelId = extractModelId(body, headers);  // 从 protobuf 提取 requestedModel
  const slot = getSlot(modelId);                   // 查 model-map.json 槽位
  return !!(slot && slot.targets && slot.targets.length > 0);
}
```

**这意味着：只要 `model-map.json` 里给某个模型配了槽位和 targets，选了该模型后请求就不会走 Windsurf 服务端，而是走 BYOK 自定义 API。Windsurf 服务端的 `cascadeAllowedModelsConfig` 权限校验根本不会触发！**

---

### 11.3 两层权限机制与绕过方式

Windsurf 的模型权限确实分两层：

| 层级 | 控制机制 | 代理能否绕过 |
|---|---|---|
| 客户端 UI 层 | `disabled` 字段控制下拉框是否可点 | ✅ 改写 `disabled=false` |
| 服务端权限层 | `cascadeAllowedModelsConfig` 控制模型使用权限 | ✅ 不走服务端，走 BYOK API |

**之前分析说"服务端权限无法绕过"是针对"走 Windsurf 服务端"的场景。但如果 MITM 劫持后走自定义 API，根本不需要 Windsurf 服务端授权。**

---

### 11.4 完整解锁方案

#### 方案：改写 `disabled` + MITM 劫持

```
1. 代理拦截 GetUserStatus 响应
2. 改写 clientModelConfigs 里所有 disabled=true → disabled=false
3. 用户在下拉框看到更多可选模型
4. 用户选择模型 → Windsurf 发 GetChatMessage
5. MITM 代理拦截 GetChatMessage
6. shouldIntercept() 检查 model-map.json → 命中槽位
7. handleGetChatMessage() → 转发到 BYOK 自定义 API
8. 自定义 API 返回结果 → Windsurf 显示
```

**整个流程不经过 Windsurf 服务端的模型权限校验。**

#### 需要改写的字段

在 `clientModelConfigs` 的 protobuf 中，`disabled` 是一个 bool 字段（wire type 0，varint 编码）：
- `disabled=true` → varint 值为 1
- `disabled=false` → varint 值为 0

改写方式：在 `renameModels` 的 `rewriteMessage` 递归中，识别 `disabled` 对应的 field number，将 varint 1 改为 0。

**但更简单的方式是**：`inject-models.js` 已经实现了往 `GetCommandModelConfigs` 响应里追加自定义模型条目的能力。可以扩展此功能，在追加条目时强制设置 `disabled=false`。

---

### 11.5 现有代码基础

| 文件 | 已有能力 | 解锁所需扩展 |
|---|---|---|
| `rename-models.js` | 递归改写 protobuf 中的 label 字符串 | 扩展：同时改写 `disabled` bool 字段 |
| `inject-models.js` | 往模型列表追加自定义条目 | 扩展：追加时强制 `disabled=false` |
| `hybrid-server.js` | MITM 拦截 GetChatMessage → BYOK API | 无需修改 |
| `provider-pool.js` | model-map.json 槽位路由 | 无需修改，配好槽位即可 |
| `handlers/chat.js` | protobuf 解析 → Anthropic/OpenAI API | 无需修改 |

---

### 11.6 可行性结论

| 方案 | 技术可行 | 实际有效 | 原因 |
|---|---|---|---|
| 改写 `disabled=false` + MITM 劫持 BYOK | ✅ 可行 | ✅ 有效 | 请求走自定义 API，不触发 Windsurf 服务端权限校验 |
| 改写 `disabled=false` 但不走 BYOK | ✅ 可行 | ❌ 无效 | 请求仍走 Windsurf 服务端，因 `cascadeAllowedModelsConfig` 不含该模型被拒绝 |
| 注入额外模型条目 + MITM 劫持 | ✅ 可行 | ✅ 有效 | `inject-models.js` 已有基础，追加条目后配好槽位即可 |

**最终结论：Free 账号通过"改写 disabled + MITM 劫持 BYOK API"的思路完全可行。AnyBridge 已有完整的 MITM 劫持链路，只需扩展 `renameModels` 或 `injectModels` 来解除 UI 限制即可。**

---

### 11.7 实施建议

**最小改动方案**：扩展 `renameModels` 函数，在改写 label 的同时，把所有 `clientModelConfigs` 条目的 `disabled` 字段从 `true` 改为 `false`。

具体步骤：
1. 在 `rename-models.js` 的 `rewriteMessage` 中增加对 `disabled` 字段的识别和改写
2. 或者在 `hybrid-server.js` 的 GetUserStatus 拦截处，增加一个 `unlockModels()` 函数专门处理 `disabled` 字段
3. 确保 `model-map.json` 里给需要 BYOK 的模型配好槽位和 targets

**注意事项**：
- 改写 `disabled` 后，所有模型在下拉框都可选，但只有配了 BYOK 槽位的模型才会走自定义 API
- 没配槽位的模型选了之后会透传给 Windsurf 服务端，Free 账号会被服务端拒绝
- 建议同时改写未配槽位模型的 `disabled=true`，只解锁配了 BYOK 的模型，避免用户选到无效模型

---

## 十二、WindsurfGate v1.3.9 对比分析与借鉴

> 分析来源：`E:/project/fix/WindsurfGate_analysis/WindsurfGate_1.3.9_分析报告.md`

### 12.1 WindsurfGate 简介

WindsurfGate 是一个商业化的 Windsurf IDE MITM 代理工具（Tauri 1.8.3 + Rust 后端），核心功能是通过卡密认证后，用共享 Pro 账号的凭据替换用户原始 Token，实现模型解锁。

### 12.2 核心原理对比

| | WindsurfGate | AnyBridge |
|---|---|---|
| **核心思路** | Token 替换 — 用共享 Pro 账号的 `client_secret` 替换原始 Bearer Token | 路由劫持 — 拦截 GetChatMessage 转发到自定义 BYOK API |
| **请求去向** | 仍然发到 Windsurf/Codeium 服务器 | 发到 Anthropic/OpenAI 等第三方 API |
| **模型解锁方式** | 天然解锁 — Pro 账号本身就有全部模型权限 | 改写 `disabled` + 配 BYOK 槽位 |
| **遥测处理** | 屏蔽所有 Telemetry gRPC | 透传给 Codeium |
| **DNS 劫持** | `host-resolver-rules` + hosts 文件 + argv.json | MITM CONNECT 代理 |
| **CA 证书** | 自签名 CA 安装到 Windows 证书存储 | MITM 模式需要 CA 证书 |
| **技术栈** | Rust（性能好，逆向难度大） | Node.js（灵活，易开发） |
| **商业模式** | 卡密 + 额度计费 | 开源，用户自带 API Key |

**WindsurfGate 的模型解锁原理**：它把请求里的 Bearer Token 替换成 Pro 账号的 `client_secret`，Windsurf 服务端返回的 `GetUserStatus` 自然就是 Pro 账号的数据——所有模型都可用，`disabled` 大多是 `false`。不需要改写任何字段。

### 12.3 可借鉴点

#### 12.3.1 遥测屏蔽（⭐⭐⭐ 高优先级，低难度）

WindsurfGate 屏蔽了以下 gRPC 调用，直接返回空响应：

| gRPC 方法 | 处理 | 说明 |
|---|---|---|
| `RecordAnalytics` | BLOCKED | 使用分析上报 |
| `RecordCortexTrajectory` | BLOCKED | Cascade 轨迹记录 |
| `RecordCortexTrajectoryStep` | BLOCKED | Cascade 步骤记录 |
| `RecordAsyncTelemetry` | BLOCKED | 异步遥测 |
| `RecordStateInitialization` | BLOCKED | 状态初始化上报 |
| `RecordCortexExecutionMeta` | BLOCKED | 执行元数据 |
| `RecordCortexGeneratorMeta` | BLOCKED | 生成器元数据 |
| `RecordTrajectorySegment` | BLOCKED | 轨迹片段 |
| `RecordEvent` | BLOCKED | 通用事件 |

**AnyBridge 目前全部透传给 Codeium**，这意味着 Windsurf 服务端能看到用户用了哪些模型、发了什么请求。对于 BYOK 场景，这些遥测数据可能暴露用户在用自定义 API。

**实施方案**：在 `hybrid-server.js` 的请求处理中，检测到这些 gRPC 方法名时直接返回空 200 响应，不转发给 Codeium。

#### 12.3.2 detect_proxy 自动设置（⭐⭐ 中优先级，低难度）

WindsurfGate 修改 Windsurf 的 `user_settings.pb`（protobuf 格式设置文件）自动开启 `detect_proxy` 设置。

这确保 Windsurf 能正确走代理。AnyBridge 目前可能依赖用户手动设置或系统代理自动检测。

**实施方案**：在 AnyBridge 启动时，读取并修改 Windsurf 的 `user_settings.pb`，开启 `detect_proxy`。

#### 12.3.3 argv.json 注入（⭐ 低优先级，低难度）

WindsurfGate 修改 `~/.windsurf/argv.json` 添加 DNS 映射规则：

```json
{
  "host-resolver-rules": "MAP server.codeium.com 127.0.0.1"
}
```

这比 AnyBridge 的 MITM CONNECT 方式更轻量——不需要安装 CA 证书，不需要处理 TLS 解密。但缺点是只能映射域名到 IP，不能做更细粒度的请求拦截（如按 gRPC 方法名分流）。

**适用场景**：如果 AnyBridge 想提供一种"轻量模式"（不需要 CA 证书），可以借鉴此方式。但当前 MITM 模式功能更完整。

#### 12.3.4 代理旁路处理（⭐ 低优先级，中难度）

WindsurfGate 的代理旁路处理很完善，处理了多种网络环境：

| 处理方式 | 说明 |
|---|---|
| `ProxyOverride` 注册表修改 | 在 Internet Settings 中添加 MITM 域名到旁路列表 |
| PAC 自动代理检测 | 检测 `AutoConfigURL`，若存在则 warn 并回退到 `NO_PROXY` |
| `NO_PROXY` 环境变量 | 用户级（`setx`）+ 进程级双保险 |
| `netsh winhttp import proxy source=ie` | 同步 WinHTTP 代理设置 |
| `ipconfig /flushdns` | DNS 缓存刷新 |
| `WINDSURF_GATE_MARKER` | 追踪自己的修改，卸载时清理 |

**适用场景**：AnyBridge 如果在某些网络环境下代理不生效（如公司 PAC 代理），可以借鉴这些处理。

#### 12.3.5 进程管理（⭐ 低优先级，低难度）

WindsurfGate 的 Windsurf 进程管理策略：

| 功能 | 实现 |
|---|---|
| 查找 Windsurf | 相对路径 → 常见安装路径 → 注册表 URL 协议 → 注册表卸载信息 |
| 启动注入 | `windsurf.exe --host-resolver-rules="MAP ..."` + `NO_PROXY` 环境变量 |
| 锁文件清理 | 删除 `SingletonLock`、`SingletonSocket`、`SingletonCookie` |
| 多窗口管理 | 保留 N 个窗口，发送关闭命令给多余窗口 |

**适用场景**：AnyBridge 如果需要自动启动 Windsurf 或管理进程，可以参考。

### 12.4 不借鉴的部分

| 功能 | 原因 |
|---|---|
| 号池系统（`pool_add_key`/`pool_remove_key`） | 不做号池，用户自带 API Key |
| Token 替换（`client_secret` 替换 Bearer Token） | 不做 Token 替换，走 BYOK 自定义 API |
| 卡密认证系统 | 不做商业化的卡密认证 |
| 反调试/反逆向 | 开源项目不需要 |
| 设备指纹采集 | 不做设备绑定 |
| AES-256-GCM 会话加密 | 不做加密存储 |

### 12.5 实施优先级

| 借鉴点 | 优先级 | 难度 | 预期收益 |
|---|---|---|---|
| 遥测屏蔽 | ⭐⭐⭐ | 低 | 保护隐私，避免 BYOK 使用行为暴露 |
| detect_proxy 自动设置 | ⭐⭐ | 低 | 提升代理可靠性 |
| 代理旁路优化 | ⭐ | 中 | 解决特殊网络环境问题 |
| argv.json 注入 | ⭐ | 低 | 可选的轻量模式 |
| 进程管理 | ⭐ | 低 | 可选的便捷功能 |

---

## 十三、模型解锁实现

### 13.1 核心原理

Windsurf 的 `ClientModelConfig` protobuf 消息中有一个 `disabled` 字段（field number 4, bool 类型），控制下拉框中模型是否可选。Free 账号所有模型 `disabled=true`，Trial/Pro 账号部分模型 `disabled=false`。

**关键发现**：`disabled` 是纯客户端 UI 标记，不参与服务端权限判定。解锁后选中模型走 MITM 劫持 BYOK API，不走 Windsurf 服务端，不触发 `cascadeAllowedModelsConfig` 权限校验。

### 13.2 ClientModelConfig Protobuf Schema（逆向自 extension.js）

| Field No | Name | Type | 说明 |
|----------|------|------|------|
| 1 | label | string (T:9) | 显示名 |
| 2 | model_or_alias | message | 嵌套消息（ModelOrAlias） |
| 22 | model_uid | string (T:9) | 模型 ID |
| 3 | credit_multiplier | float (T:2) | 积分倍率 |
| 13 | pricing_type | enum | 定价类型 |
| **4** | **disabled** | **bool (T:8)** | **是否禁用** |
| 5 | supports_images | bool (T:8) | 支持图片 |
| 6 | supports_legacy | bool (T:8) | 支持旧版 |
| 7 | is_premium | bool (T:8) | 是否高级 |
| 8 | beta_warning_message | string (T:9) | Beta 警告 |
| 9 | is_beta | bool (T:8) | 是否 Beta |
| 10 | provider | enum | 供应商 |
| 11 | is_recommended | bool (T:8) | 是否推荐 |
| 12 | allowed_tiers | enum (repeated) | 允许等级 |
| 14 | api_provider | enum | API 供应商 |
| 15 | is_new | bool (T:8) | 是否新模型 |
| 16 | partial_rollout | bool (T:8) | 部分推出 |
| 17 | rollout_fraction | float (T:2) | 推出比例 |
| 18 | max_tokens | int32 (T:5) | 最大 token |
| 19 | promo_status | message | 促销状态 |
| 20 | is_capacity_limited | bool (T:8) | 容量受限 |
| 21 | fast_status | message | 快速状态 |
| 23 | model_info | message | 模型信息 |
| 24 | model_cost_tier | enum | 费用层级 |
| 27 | description | string (T:9) | 描述 |
| 29 | smart_friend_model_uid | string (T:9) | 智能好友模型 UID |
| 30 | model_family_metadata | message | 模型族元数据 |
| 31 | is_default_model_in_family | bool (T:8) | 是否族内默认 |
| 32 | model_dimensions | message (repeated) | 模型维度 |

### 13.3 实现方案

**文件**：`sidecar/rename-models.js` 新增 `unlockModels()` 函数

**流程**：
1. 读取 `model-map.json` 中所有已启用槽位的 `modelUid` → `unlockSet`
2. 拦截 `GetUserStatus` 响应，递归遍历 protobuf
3. 识别 `ClientModelConfig` 条目（含 field22=model_uid 的子 message）
4. 对 `unlockSet` 中的模型，将 field4(disabled) varint 值从 1 改为 0
5. 对不在 `unlockSet` 中的模型，保持 `disabled=true` 不变

**Protobuf 改写细节**：
- `disabled=true` 编码：tag=`0x20` (field4, wire type 0) + varint(1)=`0x01`
- `disabled=false` 编码：tag=`0x20` + varint(0)=`0x00`
- 改写后 varint 长度不变（1字节→1字节），外层 message 的 length 前缀无需重算
- proto3 默认值 bool=false 不编码，如果 field4 不存在说明已经 disabled=false

**调用链**：`hybrid-server.js` → `proxyToCodeium()` → `GetUserStatus` 响应处理 → `renameModels()` → `unlockModels()`

### 13.4 遥测屏蔽

**文件**：`sidecar/hybrid-server.js` 新增 `BLOCKED_TELEMETRY_METHODS` 常量

屏蔽的 gRPC 方法（直接返回空 200 响应）：

| 方法 | 说明 |
|------|------|
| RecordCortexTrajectory | Cascade 轨迹记录 |
| RecordCortexTrajectoryStep | Cascade 步骤记录 |
| RecordAsyncTelemetry | 异步遥测 |
| RecordStateInitialization | 状态初始化上报 |
| RecordCortexExecutionMeta | 执行元数据 |
| RecordCortexGeneratorMeta | 生成器元数据 |
| RecordTrajectorySegment | 轨迹片段 |
| RecordEvent | 通用事件 |
| RecordCortexStateEvent | 状态事件 |

在 `handleRequest()` 和 `mitmServer` 两个入口都添加了遥测屏蔽逻辑。

### 13.5 图片能力对齐（supports_images）

#### 问题

有些模型（如 GLM）原生不支持图片理解，Windsurf 在 `clientModelConfigs` 的 `supports_images`（field 5, bool）标 false，下拉框选中后发图按钮置灰。

但解锁劫持后，请求实际走的是 **BYOK 自定义服务商**，能不能发图由**所配的目标模型**决定，跟 Windsurf 对原模型的标记**无关**：

- 劫持 GLM → 转发到支持视觉的服务商：实际能发图，但 Windsurf 把按钮置灰了 → **该能用却用不了**
- 把支持图的槽位配到纯文本 BYOK 模型：Windsurf 让发图，服务商收到图报错 → **能点却失败**

**结论：`supports_images` 应由 BYOK 槽位配置说了算，反向覆盖 Windsurf 的原始标记。**

#### 方案（层次 2：槽位手动标 + sidecar 改写）

1. `model-map.json` 槽位新增 `supportsImages` 布尔字段（默认 `true`，旧槽位无此字段也视为 true）
2. UI（slotModal 底部）加「支持图片识别」复选框，写入该字段
3. sidecar `unlockModels` 在解锁条目时，按槽位配置改写 `supports_images`(field 5)：
   - `true`  → 强制追加 field5=1（GLM 等原本不支持图的也强制可发图）
   - `false` → 删除 field5（proto3 默认 false，按钮置灰）

#### Protobuf 改写细节

原 `rewriteDisabledField` 升级为 `rewriteUnlockFields(buf, wantImages)`，对每个 ClientModelConfig 条目：

| 字段 | 处理 |
|------|------|
| field 4 (disabled) | 一律删除 → proto3 默认 false = 不禁用 |
| field 5 (supports_images) | 先删原值；wantImages=true 则末尾追加 `0x28 0x01`（tag=(5<<3)\|0=0x28, varint 1），false 则不追加 |

- 增删字段会改变条目长度，外层 `rewriteForUnlock` 用 `encVarint(child.length)` 重算长度前缀，故安全
- 追加在 message 末尾，protobuf 字段无序，解码不受影响

JSON 路径（GetUserStatus 返回 JSON 格式时）：`unlockInJson` 在条目对象内同步改写 `"supportsImages":true/false`，无该字段则在 `{` 后插入。

#### 数据流

```
model-map.json 槽位 supportsImages
  → buildUnlockSet() 返回 Map<modelUid, {supportsImages}>
  → rewriteUnlockFields() 改写 protobuf field5
  → Windsurf 下拉框发图按钮状态与 BYOK 配置一致
```

#### 备注

未来若解锁的模型列表足够全（1:1 覆盖），可直接按真实模型能力逐一设置，体验最佳。当前先用槽位手动开关。

---

## 十四、隐藏 API ID 发现（2026-06-06 补充）

### 14.1 问题

之前从 `userStatusProtoBinaryBase64` 提取模型时，误将 field 3 当作 `api_id`，实际 field 3 是 `credit_multiplier`（float 类型）。导致旧模型（`MODEL_*` 枚举）被认为"没有原始 API ID"。

### 14.2 发现

**旧模型的 API ID 藏在 field 23 → sub-field 23**（ModelInfo 子消息）。

| 路径 | 字段 | 说明 |
|------|------|------|
| field 22 | modelUid | 主 ID（新模型=API级ID，旧模型=MODEL_*枚举） |
| field 23 → sub-field 23 | apiId | ★ 隐藏的 API 级 ID |
| field 23 → sub-field 20 | sweApiId | SWE 模型的 API ID |
| field 23 → sub-field 5 | tokenizer | 分词器名称 |
| field 23 → sub-field 17 | modelUid | 重复 modelUid |
| field 23 → sub-field 18 | serverUrl | 服务端 URL |

### 14.3 验证数据

从实例4 (`aade59d2ad77e57e`, `forbidut28@gmail.com`) 提取：

| modelUid | label | 隐藏 API ID (f23.f23) |
|----------|-------|----------------------|
| MODEL_CLAUDE_4_5_OPUS | Claude Opus 4.5 | `claude-opus-4.5` |
| MODEL_CLAUDE_4_5_OPUS_THINKING | Claude Opus 4.5 Thinking | `claude-opus-4.5` |
| MODEL_PRIVATE_2 | Claude Sonnet 4.5 | `claude-sonnet-4.5` |
| MODEL_PRIVATE_3 | Claude Sonnet 4.5 Thinking | `claude-sonnet-4.5` |
| MODEL_CHAT_O3 | o3 | `o3` |
| MODEL_CHAT_O3_HIGH | o3 High Reasoning | `o3` |
| MODEL_GPT_5_2_* | GPT-5.2 系列 | `gpt-5.2` |
| MODEL_SWE_1_5_SLOW | SWE-1.5 | `swe-1p5` (f23.f20) |
| MODEL_SWE_1_5 | SWE-1.5 Fast | `swe-1p5` (f23.f20) |

### 14.4 完整提取结果

- **132 个模型**，**114 个有 API ID**（86%）
- 71 个新模型：field 22 直接就是 API 级 ID
- 43 个旧模型：通过隐藏的 f23.f23/f23.f20 获取 API ID
- 18 个没有 API ID：4 BYOK（跳过）+ 14 旧模型（需手动映射）

完整数据：`scripts/inst4_models_full.json`

### 14.5 对模型解锁的影响

解锁劫持时，sidecar 需要知道模型的**原始 API ID** 才能正确路由到 BYOK 服务商。之前只有 `MODEL_*` 枚举 ID，现在可以从 protobuf 中提取隐藏的 API ID，大幅提高映射覆盖率。

**apiId 提取优先级**：
1. field 22 不以 `MODEL_` 开头 → 直接用（新模型）
2. field 23 → sub-field 23 存在 → 用隐藏 API ID（旧模型）
3. field 23 → sub-field 20 存在 → 用 SWE API ID
4. 都没有 → `builtin_models()` 手动映射兜底
