# ui-src — HTML 源码

本目录是前端 **HTML 唯一源码**。修改后请执行：

```bash
npm run build:ui
npm run check:ui
```

## 结构

```
ui-src/
  index.html                 # 壳：head、顶栏、侧栏、<main>、@include
  partials/
    pages/                   # 各业务页
    modals/                  # 全局弹窗
    scripts-app.html         # ES module 入口（main.js）
    scripts-i18n.html
    shell-close.html
  manifest.json              # 切片元数据（只读参考）
```

## Include

```html
<!-- @include partials/pages/settings.html -->
```

路径相对 `ui-src/`。构建脚本：`scripts/build-ui.mjs`。

## 事件

- **禁止**在 HTML 中写 `onclick` / `onchange` 等内联事件。
- 使用 `data-action` / `data-args` / `data-events` 等，由 `ui/assets/scripts/05-actions.js` 统一委托。
- 约定详见 `ui/README.md`。

## 脚本

- 入口：`ui/assets/scripts/main.js`（`type="module"`）
- 共享层：`api/`、`ui/`、`state/`（真正 `export`）
- 功能模块仍可依赖 `globalThis`；新代码优先 `import` 共享层

## 注意

- 不要手改 `ui/index.html`（产物）。
- 弹窗放在 `partials/modals/`。
- 新增 script 时同步改 `main.js` 与 `scripts/check-ui.mjs` 的 `moduleImportOrder`。
