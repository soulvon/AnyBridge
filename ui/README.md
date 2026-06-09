# UI 目录维护说明

当前前端不使用构建工具，Tauri 直接加载 `ui/` 静态目录。拆分原则是先保持运行方式简单，再逐步降低文件耦合。

## 当前结构

- `index.html`：页面结构和静态 DOM。尽量只放 HTML，不再内联大段 CSS/JS。
- `assets/app.css`：CSS 加载清单，只负责按顺序 `@import` 拆分后的样式文件。
- `assets/styles/00-foundation.css`：字体、主题变量、reset、通用开关和基础模态框。
- `assets/styles/10-shell.css`：顶栏、导航、IDE 选择器、窗口控制、主布局、卡片。
- `assets/styles/20-providers-models.css`：统计卡、供应商、模型选择面板、模型表格、接入卡片。
- `assets/styles/30-pages.css`：日志、设置、按钮、流程图、评测和响应式规则。
- `assets/styles/40-modals.css`：玻璃模态框、工具栏面板、全屏编辑器。
- `assets/scripts/00-bridge.js`：诊断日志、Tauri bridge 绑定。
- `assets/scripts/10-shell.js`：顶栏导航、目标 IDE 选择器、自定义 alert/confirm。
- `assets/scripts/20-runtime.js`：代理开关、状态、统计、窗口控制、主题、日志、接入、配置。
- `assets/scripts/30-providers-eval.js`：供应商卡片、能力标签、视觉风险提示、评测页。
- `assets/scripts/40-model-picker.js`：供应商编辑器、模型图标、模型分组、模型选择面板。
- `assets/scripts/50-model-map.js`：模型映射、显示名设置、扩展槽位、添加映射、故障转移。
- `assets/scripts/60-updater.js`：自动更新、下载重试、更新弹窗、代理按钮绑定。
- `assets/scripts/90-init.js`：启动流程。

所有 JS 仍使用普通 classic script，而不是 `type="module"`，因为页面里还有不少 `onclick` / `onchange` 内联处理器，需要函数留在全局作用域。新增拆分文件时必须在 `index.html` 中保持依赖顺序：bridge → shell/runtime → feature → updater → init。

## 后续拆分顺序

1. 先把内联事件迁移成 `data-action` + 事件委托，减少 HTML 与 JS 的直接耦合。
2. 迁移完内联事件后，把 classic scripts 改成 `type="module"`，用显式 import/export 管依赖。
3. 模块化后再抽共享层：
   - `state/`：配置、供应商、映射、日志等共享状态
   - `api/`：Tauri invoke/event 封装
   - `ui/`：通用弹窗、toast、表单、表格、选择器
   - `features/`：providers、model-map、eval、updater 等业务模块

## 验证建议

每次改 UI 后至少跑：

```bash
npm run check:ui
cargo check
```

响应式改动还要在 `900x600` 和 `1280x720` 各看一次，重点确认顶栏导航、弹窗和表格没有横向溢出。
