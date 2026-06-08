# Scripts 目录说明

本目录包含项目的各类脚本工具，按功能分类组织。

## 📂 目录结构

### 🔧 build/ - 构建脚本
用于构建和打包 sidecar 的脚本

- `build_protected_sidecar.py` - 构建加密保护版 sidecar
- `build_sidecar_plain.py` - 构建普通版 sidecar
- `PROTECTION_GUIDE.md` - 加密保护指南

### 🖼️ vision-diagnostics/ - Vision 功能诊断工具
用于诊断和修复图片理解功能问题的工具集

- `fix_vision_capability.cjs` - 自动修复 provider 的 vision 配置 ⭐
- `test_vision_api.cjs` - 直接测试 API 的 vision 能力 ⭐
- `find_real_image_request.cjs` - 查找历史图片请求
- `check_image_in_mitm.cjs` - 统计 MITM 日志中的图片请求
- `analyze_image_issue.cjs` - 对比分析不同日期的图片请求
- `inspect_image_format.cjs` - 检查图片请求的详细格式
- `inspect_latest_image.cjs` - 检查最近一条图片请求
- `dump_image_payload.cjs` - 导出完整 payload 供深度分析
- `README.md` - 工具使用说明

详细文档参见：`spec/10-Vision能力配置问题调查-VisionCapabilityIssueInvestigation.md`

### 🔍 probe/ - 探测脚本
用于探测和调试各种功能的测试脚本

- `probe_billing.py` - 计费探测
- `probe_context.py` - 上下文探测
- `probe_deep.py` - 深度探测
- `probe_gpt.py` / `probe_gpt2.py` - GPT 探测
- `probe_mechanism.py` - 机制探测
- `probe_models.py` / `probe_models2.py` - 模型探测
- `probe_proxy.py` - 代理探测
- `probe_streaming.py` - 流式传输探测
- `probe_ua.py` - User-Agent 探测

### 📦 release/ - 发布脚本
用于发布和版本管理的脚本

- `build_merged_latest_json.cjs` - 构建合并的 latest.json

### 📊 data/ - 数据文件
脚本运行产生的数据文件

- `inst4_models_full.json` - Windsurf 模型完整数据
- `_real_image_request.json` - 真实图片请求示例

## 🚀 常用命令

### Vision 功能诊断

```bash
# 修复 provider 的 vision 配置
node scripts/vision-diagnostics/fix_vision_capability.cjs "供应商名称"

# 测试 API 的 vision 能力
$env:TEST_API_BASE = "https://api.example.com"
$env:TEST_API_KEY = "sk-..."
$env:TEST_MODEL = "model-name"
node scripts/vision-diagnostics/test_vision_api.cjs

# 查找历史图片请求
node scripts/vision-diagnostics/find_real_image_request.cjs
```

### 构建

```bash
# 构建加密版 sidecar
python scripts/build/build_protected_sidecar.py

# 构建普通版 sidecar
python scripts/build/build_sidecar_plain.py
```

## 📚 相关文档

- Vision 功能问题调查：`spec/10-Vision能力配置问题调查-VisionCapabilityIssueInvestigation.md`
- 构建保护指南：`scripts/build/PROTECTION_GUIDE.md`
- Vision 工具说明：`scripts/vision-diagnostics/README.md`

## 🔧 维护规范

### 新增脚本命名规范

- **诊断工具**：`<功能>_<操作>.cjs` → 放入对应功能目录
- **探测脚本**：`probe_<功能>.py` → 放入 `probe/`
- **构建脚本**：`build_<描述>.py` → 放入 `build/`
- **数据文件**：`_<描述>.<ext>` 或 `<功能>_data.<ext>` → 放入 `data/`

### 临时脚本处理

一次性使用的脚本在完成任务后应该删除，避免混乱。如果有复用价值，应该：
1. 重命名为规范格式
2. 移动到对应功能目录
3. 在相关 README 中添加说明

## 📞 问题反馈

如果脚本运行遇到问题，请：
1. 检查环境变量是否正确设置
2. 查看脚本头部的使用说明
3. 查阅相关文档了解功能背景
