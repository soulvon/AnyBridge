# BYOK 限速劫持复盘 —— "消息回弹"根因与伪造响应实现

调查时间：2026-06-08

---

## 一、问题现象

用户反馈：**用自己的 API Key 走 BYOK 代理仍然会"消息回弹"**（输入消息后立即被弹回，无法发送）。

最初以为是"额度/配额耗尽"问题，排查后发现根本不是——Codeium 服务端在 `CheckUserMessageRateLimit` 和 `CheckChatCapacity` 两个 API 上返回限速响应，Devin 客户端**在发消息前**检查这些 API 拿到"限速"就**直接拒绝发送**，`GetChatMessage` 根本不会被调到。

关键词定位：`overall message rate limit`（全局消息频率限制），不是配额耗尽。

---

## 二、两个限速检查 API

### 2.1 `CheckUserMessageRateLimit`

- **位置**：`exa.api_server_pb.ApiServerService`（HTTPS 远程服务）
- **客户端**：`createConnectTransport({baseUrl, useBinaryFormat: true, httpVersion: "1.1"})`
- **路径**：`POST /exa.api_server_pb.ApiServerService/CheckUserMessageRateLimit`
- **请求**：`{ metadata, modelUid }`（proto3）
- **响应 Proto 结构**（逆向自 Devin 扩展 `extension.js`）：
  ```protobuf
  message CheckUserMessageRateLimitResponse {
    bool hasCapacity = 1;
    string message = 2;
    int32 messagesRemaining = 3;
    int32 maxMessages = 4;
    int64 resetsInSeconds = 5;
  }
  ```

### 2.2 `CheckChatCapacity`

- **位置**：`exa.language_server_pb.LanguageServerService`（本地 LS 进程 → 转发到 Codeium）
- **客户端**：`createConnectTransport({baseUrl: http://localhost:${lsPort}, useBinaryFormat: true, httpVersion: "1.1"})`
- **路径**：`POST /exa.language_server_pb.LanguageServerService/CheckChatCapacity`
- **请求**：`{ metadata, model_uid }`
- **响应 Proto 结构**：
  ```protobuf
  message CheckChatCapacityResponse {
    bool has_capacity = 1;
    string message = 2;
    int32 active_sessions = 3;
  }
  ```

### 2.3 流量路径

| API | Devin → | LS → | 到达代理 |
|-----|--------|-----|---------|
| CheckUserMessageRateLimit | HTTPS server.codeium.com | — | MITM 直接拦截 |
| CheckChatCapacity | HTTP localhost:LS_PORT | HTTPS server.codeium.com | LS 转发后被 MITM 拦截 |

两种情况都过代理 → 同一个 `getRpcMethod(req.url)` 提取方法名 → 同一个 `RATE_LIMIT_METHODS` 集合匹配。

---

## 三、劫持实现

### 3.1 拦截位置

在 `hybrid-server.js` 的两个 handler 中都加上拦截：

| Handler | 用途 |
|---------|------|
| `handleRequest`（HTTP 入口） | 处理非 TLS 请求 + nginx 模式 |
| mitmServer callback（MITM 解密后） | 处理 TLS 解密后的请求 |

两处逻辑相同：
1. 在 telemetry blocking 之后、GetChatMessage 拦截之前
2. 命中 `RATE_LIMIT_METHODS` → 伪造响应 → 直接 return
3. 不转发到 Codeium（关键！）

### 3.2 响应帧格式

Connect-RPC over HTTP/1.1 + binary format 的 unary 响应：

```
HTTP 200
Content-Type: application/proto
Content-Length: <frame size>

[1 byte flags = 0x00]              // 0=未压缩, 1=gzip 压缩
[4 bytes big-endian length]       // proto body 长度
[N bytes proto body]
```

- **不要用 `grpc-status` header**！这是 gRPC over HTTP/2 的 trailer header，HTTP/1.1 不支持
- **必须设 `content-length`**，避免 Node.js 用 `transfer-encoding: chunked`（某些严格客户端不接受）
- Connect-RPC 客户端对成功响应不检查 trailers，只解析 5 字节前缀 + body

### 3.3 Proto 编码

利用已有的 `proto.js` 工具函数：

```js
import { writeVarintField } from './proto.js';

// hasCapacity = true → field 1, wire type 0 (varint)
const hasCapacity = writeVarintField(1, 1);
// messagesRemaining = 9999 → field 3
const messagesRemaining = writeVarintField(3, 9999);
// maxMessages = 9999 → field 4
const maxMessages = writeVarintField(4, 9999);
```

**关键点**：proto3 **默认值不编码**（`false`/`0`/`""` 不序列化到 wire），所以只编码非零字段即可，生成的二进制最小。

### 3.4 完整函数

```js
// 需要劫持的限速检查方法集合
const RATE_LIMIT_METHODS = new Set([
  'CheckUserMessageRateLimit',
  'CheckChatCapacity',
]);

function buildRateLimitOkResponse(method) {
  // 通用: hasCapacity = true
  const hasCapacity = writeVarintField(1, 1);

  if (method === 'CheckChatCapacity') {
    // CheckChatCapacityResponse: active_sessions=0 是默认值,不编码
    return Buffer.concat([hasCapacity]);
  }

  // CheckUserMessageRateLimitResponse: 加上 messagesRemaining 和 maxMessages
  const messagesRemaining = writeVarintField(3, 9999);
  const maxMessages = writeVarintField(4, 9999);
  return Buffer.concat([hasCapacity, messagesRemaining, maxMessages]);
}

// 拦截点
if (RATE_LIMIT_METHODS.has(method)) {
  const protoBody = buildRateLimitOkResponse(method);
  const frame = Buffer.alloc(5 + protoBody.length);
  frame[0] = 0; // flags: uncompressed
  frame.writeUInt32BE(protoBody.length, 1);
  protoBody.copy(frame, 5);
  res.writeHead(200, {
    'content-type': 'application/proto',
    'content-length': frame.length,
  });
  res.end(frame);
  return;
}
```

---

## 四、Proto 字段编号逆向方法

当不确定某个 API 的 proto 字段编号时，可以：

1. **从 Devin 扩展的 minified 代码提取**：
   ```bash
   node -e "
   const fs = require('fs');
   const code = fs.readFileSync('extension.js', 'utf8');
   const idx = code.indexOf('CheckUserMessageRateLimitResponse');
   console.log(code.substring(idx - 50, idx + 200));
   "
   ```
   输出形如：
   ```js
   hasCapacity=1;message=2;messagesRemaining=3;maxMessages=4;resetsInSeconds=5
   ```
   proto3 编译后的 initPartial 调用直接暴露了字段编号。

2. **从 windsurf-pool 等开源同类项目反推**：
   - `usageService.ts` 中的 `parseRateLimitBody` 知道响应有 `hasCapacity` / `messagesRemaining` / `resetsInSeconds` 字段
   - `cascadeProbe.ts` 中提到 `overall message rate limit` 关键词

3. **用我们的 `parseFields` 解析真实响应二进制**：
   ```js
   const fields = parseFields(realResponseBody);
   console.log(fields); // [{field: 1, wireType: 0, value: 1}, ...]
   ```

---

## 五、常见踩坑

### 5.1 响应格式错误

| 错误写法 | 问题 | 正确写法 |
|---------|------|---------|
| `res.writeHead(200, {'content-type': 'application/proto'}); res.end(protoBody);` | 没有 5 字节帧头,Connect-RPC 解析失败 | 必须 `Buffer.concat([帧头, body])` |
| `res.writeHead(200, {'grpc-status': '0'})` | `grpc-status` 是 gRPC over HTTP/2 的 trailer,HTTP/1.1 中无效 | 用 HTTP 200 表示成功,Connect-RPC 不需要 trailer |
| 不设 `content-length` | Node.js 默认用 chunked encoding,某些客户端不兼容 | 显式设 `content-length: frame.length` |
| `frame[0] = 1` (压缩标志) | 客户端会尝试 gzip 解压,导致解析失败 | `frame[0] = 0` (未压缩) |

### 5.2 Proto 字段编号错误

**症状**：客户端拿到响应后不报错但行为异常（比如 hasCapacity 总是 false）。

**原因**：proto 字段编号写错了。比如把 `hasCapacity` 写成 field 2 而实际是 field 1。

**解决**：逆向扩展代码或参考同类开源项目。proto 字段编号是 protobuf 编码的基础，错了就没救。

### 5.3 proto3 vs proto2 编码差异

- **proto3 默认值不编码**：`hasCapacity=false` / `messagesRemaining=0` / `message=""` **不会出现在 wire 上**
- **proto2 默认值会编码**

Devin 扩展用的是 proto3，所以只编码需要的非零字段即可。

### 5.4 漏掉方法

Devin 客户端有两个限速检查 API：
- `CheckUserMessageRateLimit`（ApiServerService）—— 容易被发现
- `CheckChatCapacity`（LanguageServerService）—— 容易被遗漏

两个都必须劫持，缺一就会回弹。

---

## 六、经验总结

### 6.1 协议层经验

1. **Connect-RPC / gRPC 都有"客户端预检"机制**——发主请求前会先调预检 API（如 `Check*Capacity` / `Check*RateLimit`）。劫持时**必须同时劫持预检 + 主请求**，否则客户端会在预检阶段就被拦截。
2. **响应帧格式与传输层协议相关**：
   - HTTP/1.1 + Connect-RPC：5 字节帧头 + proto body，不用 trailers
   - HTTP/2 + gRPC：HPACK 压缩 + trailers
   - 不能混用（`grpc-status` 在 HTTP/1.1 无效）
3. **proto3 编码省字节**：默认值不编码，但意味着客户端解析到 `undefined` 而不是 `0`/`false`/`""`。在 JS 中配合 `?? defaultValue` 模式可以优雅地处理"字段不存在"。

### 6.2 调试经验

1. **Proto 字段编号逆向**：minified JS 里的 `initPartial` 调用直接暴露了字段映射（`hasCapacity=1;message=2;...`），是最高效的字段编号来源。
2. **MITM 日志只记录 BYOK 拦截的请求**，透传请求不进日志——要观察透传流量需要另外开启 mitm-logger 的全量日志。
3. **Proto 调试可借助 `parseFields` 反解**——从真实响应二进制反推字段值，对照预期确认劫持是否正确。

### 6.3 代码组织经验

- **`RATE_LIMIT_METHODS` 用 Set 集合**——后续如果 Devin/Windsurf 增加新的限速 API，只需往 Set 里加一项，`buildRateLimitOkResponse` 加一个分支即可。
- **拦截点放在 telemetry blocking 之后、GetChatMessage 之前**——保证限速劫持优先级最高，且不会误伤其他合法流量。
- **两个 handler 都加拦截**（HTTP + MITM）——Devin 走 nginx 模式用 HTTP handler，走证书模式用 MITM handler，缺一会漏拦截。

---

## 七、相关文件

- `sidecar/hybrid-server.js:165-200` —— `buildRateLimitOkResponse` 函数 + `RATE_LIMIT_METHODS` 集合
- `sidecar/hybrid-server.js:432-444` —— HTTP handler 拦截点
- `sidecar/hybrid-server.js:510-522` —— MITM handler 拦截点
- `sidecar/proto.js` —— `writeVarintField` / `parseFields` 等 protobuf 工具
- `sidecar/handlers/chat.js` —— 已有 `GetChatMessage` 拦截（流式）的参考实现
