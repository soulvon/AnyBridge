# Findings — UI HTML 拆分

## 现状
- `ui/index.html` ~6032 行，手写源文件，非构建产物
- Tauri `frontendDist: "../ui"`
- CSS/JS 已拆；HTML 未拆
- ~443 内联事件，classic script 全局函数

## 边界（1-based）
- L15 TOP BAR
- L142 WORKSPACE
- L219 MAIN
- Pages: platform-proxy, providers, provider-editor, slot-editor, model-slots, models, eval, eval-history, extensions, proxy, more-platforms, platform-*, settings
- 大量 modal 夹在 page 中或尾部
- Scripts 在 body 末尾

## 策略
自动切片 + include 拼装 + 一致性校验，避免手改 DOM。
