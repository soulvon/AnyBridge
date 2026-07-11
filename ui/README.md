# UI 目录维护说明

当前前端使用**轻量 HTML 构建**：源码在 `ui-src/`，拼装产物为 `ui/index.html`。  
Tauri 仍直接加载 `ui/` 静态目录（`frontendDist: ../ui`），运行时行为与拆分前一致。

## 源码 vs 产物

| 路径 | 角色 |
|------|------|
| `ui-src/index.html` | 壳：顶栏、侧栏、`@include` 清单 |
| `ui-src/partials/pages/*.html` | 各业务页 DOM |
| `ui-src/partials/body-tail.html` | `</main>` 之后的 toast/弹窗/脚本标签 |
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

## 当前结构

- `ui/assets/app.css`：CSS 加载清单，只负责按顺序 `@import` 拆分后的样式文件。
- `ui/assets/styles/00-foundation.css`：字体、主题变量、reset、通用开关和基础模态框。
- `ui/assets/styles/10-shell.css`：顶栏、导航、IDE 选择器、窗口控制、主布局、卡片。
- `ui/assets/styles/20-providers-models.css`：统计卡、供应商、模型选择面板、模型表格、接入卡片。
- `ui/assets/styles/30-pages.css`：日志、设置、按钮、流程图、评测和响应式规则。
- `ui/assets/styles/40-modals.css`：玻璃模态框、工具栏面板、全屏编辑器。
- `ui/assets/styles/50-platforms.css`：平台页样式。
- `ui/assets/scripts/00-bridge.js`：诊断日志、Tauri bridge 绑定。
- `ui/assets/scripts/10-shell.js`：顶栏导航、目标 IDE 选择器、自定义 alert/confirm。
- `ui/assets/scripts/20-runtime.js`：代理开关、状态、统计、窗口控制、主题、日志、接入、配置。
- `ui/assets/scripts/30-providers-eval.js`：供应商卡片、能力标签、视觉风险提示、评测页。
- `ui/assets/scripts/40-model-picker.js`：供应商编辑器、模型图标、模型分组、模型选择面板。
- `ui/assets/scripts/50-model-map.js`：模型映射、显示名设置、扩展槽位、添加映射、故障转移。
- `ui/assets/scripts/52-proxy-routes.js`：代理路由。
- `ui/assets/scripts/55-platforms.js`：平台页逻辑。
- `ui/assets/scripts/65-extensions.js`：扩展。
- `ui/assets/scripts/60-updater.js`：自动更新、下载重试、更新弹窗、代理按钮绑定。
- `ui/assets/scripts/70-healthcheck.js`：健康检查。
- `ui/assets/scripts/90-init.js`：启动流程。

所有 JS 仍使用普通 classic script，而不是 `type="module"`，因为页面里还有不少 `onclick` / `onchange` 内联处理器，需要函数留在全局作用域。新增拆分文件时必须在 `ui-src/partials/body-tail.html`（或拼装后的 script 列表）中保持依赖顺序：bridge → shell/runtime → feature → updater → init。

## 约定（长期维护）

1. **HTML 源码只在 `ui-src/`**；不要直接编辑 `ui/index.html`。  
2. **新代码尽量不要新增 `onclick=` / `onchange=`**；优先 `data-action` + 事件委托（迁移中）。  
3. 一页一个 partial；全局弹窗放在 `body-tail` 或后续 `partials/modals/`。  
4. 改完 HTML 必须 `npm run build:ui && npm run check:ui`。  
5. 零回归：构建只做文本拼装，不改 DOM 语义、不压缩、不改属性顺序。

## 相关脚本

| 命令 | 作用 |
|------|------|
| `npm run build:ui` | 从 `ui-src` 生成 `ui/index.html` |
| `npm run build:ui:watch` | 监听 `ui-src` 自动重建 |
| `npm run check:ui` | 构建新鲜度 + 脚本顺序 + 页面 id + JS 语法 |
| `node scripts/split-ui-html.mjs` | 仅在从整页 HTML 重新切片时使用（非常规） |

## 后续拆分顺序

1. 把 `body-tail` 中的弹窗再拆到 `partials/modals/`（保持 include 顺序即可）。  
2. 把内联事件迁移成 `data-action` + 事件委托，减少 HTML 与 JS 的直接耦合。  
3. 迁移完内联事件后，把 classic scripts 改成 `type="module"`，用显式 import/export 管依赖。  
4. 模块化后再抽共享层：
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
