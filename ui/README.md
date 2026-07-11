# UI 目录维护说明

当前前端使用**轻量 HTML 构建**：源码在 `ui-src/`，拼装产物为 `ui/index.html`。  
Tauri 仍直接加载 `ui/` 静态目录（`frontendDist: ../ui`），运行时行为与拆分前一致。

## 源码 vs 产物

| 路径 | 角色 |
|------|------|
| `ui-src/index.html` | 壳：顶栏、侧栏、`@include` 清单 |
| `ui-src/partials/pages/*.html` | 各业务页 DOM |
| `ui-src/partials/modals/*.html` | 全局弹窗 |
| `ui-src/partials/scripts-app.html` | ES module 入口（`main.js`） |
| `ui/index.html` | **构建产物**（由 `npm run build:ui` 生成，请勿手改） |
| `ui/assets/**` | CSS / JS / 图标（本阶段仍直接维护，不经拼装） |

### 修改 HTML 的正确流程

1. 只改 `ui-src/` 下的文件  
2. 运行 `npm run build:ui`（或 `npm run build:ui:watch`）  
3. 运行 `npm run check:ui`  
4. `tauri dev` / `tauri build` 会通过 `beforeDevCommand` / `beforeBuildCommand` 自动执行 `build:ui`

Include 语法（路径相对 `ui-src/`）：

```html
<!-- @include partials/pages/settings.html -->
```

## 事件约定（data-action 总线）

内联 `onclick` / `onchange` 已迁移为中央委托，实现见 `ui/assets/scripts/05-actions.js`。

**新代码禁止再写 `onclick=` / `onchange=` 等内联事件**（程序化 `el.onclick = fn` 除外）。

常用写法：

```html
<button data-action="openSettings">设置</button>
<button data-action="navigateTo" data-arg="proxy">代理</button>
<button data-action="updateProxyRouteTarget" data-args='[0,"providerId"]' data-pass-value></button>
<select data-action="onTargetIdeChange" data-events="change"></select>
<input data-action="filterSlotCatalog" data-events="input">
<input type="checkbox" data-action="toggleCbModelEnabled" data-events="change" data-args="[0]" data-pass-checked>
<button data-action-call="editCodexProviderConfig(&quot;id&quot;)"></button>
```

属性速查：

| 属性 | 含义 |
|------|------|
| `data-action` | 调用 `window[fnName]` |
| `data-arg` / `data-args` | 单参 / JSON 数组参数 |
| `data-pass-this` / `data-pass-value` / `data-pass-checked` / `data-pass-event` | 追加运行时参数 |
| `data-events` | 监听事件列表（默认 click；input/select/textarea 默认含 change） |
| `data-actions` | 多事件映射（优先于 `data-action`） |
| `data-action-chain` | 多步调用 |
| `data-action-call` | 解析简单调用串（动态模板） |
| `data-assign` / `data-set` + `data-set-value` | 先写全局变量再调用 |
| `data-stop` / `data-prevent` / `data-only-self` / `data-key` | 事件控制 |
| `data-click-id` / `data-clear-id` | 触发其它元素 click / 清空 input |

兼容：若元素仍带原生 `on*`，总线会跳过，避免双触发。

## 脚本加载（ES module + 共享层）

业务脚本为 **ES module**，由单一入口加载：

```html
<script type="module" src="./assets/scripts/main.js"></script>
```

`main.js` 加载顺序：

1. **共享层（真正 export）**  
   - `api/bridge.js` — Tauri bridge（`invoke` / `bindTauriBridge` / `_diag`）  
   - `ui/dom.js` — `setText` / `escapeHtml` / `escAttr` / `fmtNum` …  
   - `ui/feedback.js` — `showCustomAlert` / `showBottomToast` / confirm / prompt  
   - `state/logs.js` — `addLog` / 日志状态与查看器  
2. **功能模块**  
   `05-actions` → `10-shell` → `20-runtime` → … → `90-init`

### 模块约定

1. **共享层**用 `export`，并在模块内 mirror 到 `globalThis`（兼容 `data-action` 与尚未 import 的自由变量）。  
2. **功能模块**可 `import { … } from './api|ui|state/…'`；尚未迁出的跨文件符号仍走 `globalThis`。  
3. 顶层 `function` 保留声明 + 文末 mirror（供 data-action）。  
4. 顶层共享状态用 `globalThis.xxx = …` 或迁入 `state/*` 后 `export`。  
5. i18n 仍为 classic script。  
6. 新增共享文件：放进对应目录，加入 `main.js` 与 `scripts/check-ui.mjs` 的 `moduleImportOrder`。

### 当前脚本

**共享层**

- `ui/assets/scripts/api/bridge.js`  
- `ui/assets/scripts/ui/dom.js`  
- `ui/assets/scripts/ui/feedback.js`  
- `ui/assets/scripts/state/logs.js`  

**入口 / 兼容**

- `ui/assets/scripts/main.js`：ES module 入口  
- `ui/assets/scripts/00-bridge.js`：re-export `api/bridge.js`（兼容旧路径）  

**功能**

- `05-actions.js`：中央 `data-action` 事件委托  
- `10-shell.js`：顶栏导航、目标 IDE、平台侧栏  
- `20-runtime.js`：代理开关、状态、统计、窗口、主题、配置  
- `30-providers-eval.js`：供应商 / 评测  
- `40-model-picker.js`：模型选择面板  
- `50-model-map.js`：模型映射  
- `52-proxy-routes.js`：代理路由  
- `55-platforms.js`：平台页  
- `65-extensions.js`：扩展  
- `60-updater.js`：自动更新  
- `70-healthcheck.js`：健康检查  
- `90-init.js`：启动流程  

样式：`ui/assets/app.css` + `styles/00-foundation.css` … `50-platforms.css`

## 约定（长期维护）

1. **HTML 源码只在 `ui-src/`**；不要直接编辑 `ui/index.html`。  
2. **禁止新增内联 `on*` 事件**；一律 `data-action`。  
3. 一页一个 partial；全局弹窗放在 `partials/modals/`。  
4. 改完 HTML 必须 `npm run build:ui && npm run check:ui`。  
5. 构建只做文本拼装。  
6. 新共享能力优先放 `api/` / `ui/` / `state/` 并 `export`；业务页逐步 `import`，再收紧 globalThis。

## 相关脚本

| 命令 | 作用 |
|------|------|
| `npm run build:ui` | 从 `ui-src` 生成 `ui/index.html` |
| `npm run build:ui:watch` | 监听 `ui-src` 自动重建 |
| `npm run check:ui` | 构建新鲜度 + module 入口 + 页面 id + JS 语法 |
| `node scripts/migrate-inline-actions.mjs` | 静态 HTML 内联事件迁移（已完成） |
| `node scripts/migrate-js-inline-actions.mjs` | JS 模板内联事件迁移（已完成） |
| `node scripts/to-es-modules.mjs` | classic → ES module（已完成） |

## 后续拆分顺序

1. ~~HTML 构建 + partials~~  
2. ~~`data-action` 事件委托~~  
3. ~~ES module 入口~~  
4. ~~共享层第一刀：`api/bridge` + `ui/dom` + `ui/feedback` + `state/logs`~~（已完成）  
5. 继续抽共享层 / 业务模块：  
   - `state/providers`、`state/model-map`  
   - `api/config`（load/save config）  
   - `features/*` 按页拆分，逐步去掉 globalThis 自由变量  

## 验证建议

```bash
npm run build:ui
npm run check:ui
```

响应式改动还要在 `900x600` 和 `1280x720` 各看一次。
