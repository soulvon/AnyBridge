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

## 脚本加载（ES module）

业务脚本已改为 **ES module**，由单一入口加载：

```html
<script type="module" src="./assets/scripts/main.js"></script>
```

`main.js` 按依赖顺序 side-effect import：

`00-bridge` → `05-actions` → `10-shell` → `20-runtime` → … → `90-init`

### 模块约定（P3 零回归策略）

1. **顶层 `function` / `class` 保留声明**（模块内 hoist），文末 mirror 到 `globalThis`，供 `data-action` 与其它模块自由变量使用。  
2. **顶层 `let` / `const` / `var` 改写为 `globalThis.name = ...`**，保证跨模块可读写共享状态（如 `invoke`、`providerStore`）。  
3. 浏览器模块对 `globalThis` 已有属性的自由变量读写，与 classic 全局脚本一致。  
4. i18n 仍为 classic script（`zh-CN.js` / `en-US.js` / `i18n.js`），挂 `window.ByokI18nCatalog`。  
5. 新增业务文件：加入 `main.js` import 列表，并在 `scripts/check-ui.mjs` 的 `moduleImportOrder` 中登记。

### 当前脚本

- `ui/assets/scripts/main.js`：ES module 入口  
- `ui/assets/scripts/00-bridge.js`：诊断日志、Tauri bridge 绑定  
- `ui/assets/scripts/05-actions.js`：中央 `data-action` 事件委托总线  
- `ui/assets/scripts/10-shell.js`：顶栏导航、目标 IDE 选择器、自定义 alert/confirm  
- `ui/assets/scripts/20-runtime.js`：代理开关、状态、统计、窗口控制、主题、日志、接入、配置  
- `ui/assets/scripts/30-providers-eval.js`：供应商卡片、能力标签、视觉风险提示、评测页  
- `ui/assets/scripts/40-model-picker.js`：供应商编辑器、模型图标、模型分组、模型选择面板  
- `ui/assets/scripts/50-model-map.js`：模型映射、显示名设置、扩展槽位、添加映射、故障转移  
- `ui/assets/scripts/52-proxy-routes.js`：代理路由  
- `ui/assets/scripts/55-platforms.js`：平台页逻辑  
- `ui/assets/scripts/65-extensions.js`：扩展  
- `ui/assets/scripts/60-updater.js`：自动更新  
- `ui/assets/scripts/70-healthcheck.js`：健康检查  
- `ui/assets/scripts/90-init.js`：启动流程  

样式：

- `ui/assets/app.css`：CSS 加载清单  
- `ui/assets/styles/00-foundation.css` … `50-platforms.css`

## 约定（长期维护）

1. **HTML 源码只在 `ui-src/`**；不要直接编辑 `ui/index.html`。  
2. **禁止新增内联 `on*` 事件**；一律 `data-action` / `data-actions` / `data-action-call`。  
3. 一页一个 partial；全局弹窗放在 `partials/modals/`。  
4. 改完 HTML 必须 `npm run build:ui && npm run check:ui`。  
5. 构建只做文本拼装，不改 DOM 语义、不压缩、不改属性顺序。  
6. 新共享状态用 `globalThis.xxx = ...`（或后续正式 `export`）；新 handler 用顶层 `function` 并确保 mirror 到 `globalThis`。

## 相关脚本

| 命令 | 作用 |
|------|------|
| `npm run build:ui` | 从 `ui-src` 生成 `ui/index.html` |
| `npm run build:ui:watch` | 监听 `ui-src` 自动重建 |
| `npm run check:ui` | 构建新鲜度 + module 入口 + 页面 id + JS 语法 |
| `node scripts/split-ui-html.mjs` | 仅在从整页 HTML 重新切片时使用（非常规） |
| `node scripts/migrate-inline-actions.mjs` | 静态 HTML 内联事件迁移（已完成，保留备用） |
| `node scripts/migrate-js-inline-actions.mjs` | JS 模板内联事件迁移（已完成，保留备用） |
| `node scripts/to-es-modules.mjs` | classic → ES module 转换（已完成，保留备用） |

## 后续拆分顺序

1. ~~把 `body-tail` 中的弹窗再拆到 `partials/modals/`~~（已完成）  
2. ~~把内联事件迁移成 `data-action` + 事件委托~~（已完成）  
3. ~~把 classic scripts 改成 `type="module"`~~（已完成：入口 + globalThis 共享）  
4. 模块化后再抽共享层（真正的 `import`/`export`，逐步去掉 globalThis 依赖）：
   - `state/`：配置、供应商、映射、日志等共享状态  
   - `api/`：Tauri invoke/event 封装  
   - `ui/`：通用弹窗、toast、表单、表格、选择器  
   - `features/`：providers、model-map、eval、updater 等业务模块  

## 验证建议

每次改 UI 后至少跑：

```bash
npm run build:ui
npm run check:ui
```

响应式改动还要在 `900x600` 和 `1280x720` 各看一次，重点确认顶栏导航、弹窗和表格没有横向溢出。
