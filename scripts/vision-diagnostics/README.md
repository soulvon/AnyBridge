# Vision 诊断工具集

本目录包含用于诊断和修复 AnyBridge 图片理解功能的工具脚本。

## 📋 工具清单

### 🔧 修复工具

#### `fix_vision_capability.cjs`
**用途**: 自动修复 provider 的 vision 配置

**使用方法**:
```bash
# 为整个 provider 启用 vision
node scripts\fix_vision_capability.cjs "君の公益"

# 只为特定模型启用
node scripts\fix_vision_capability.cjs "君の公益" claude-opus-4-6,claude-opus-4-7
```

---

### 🔍 诊断工具

#### `find_real_image_request.cjs`
从 MITM 日志中查找真实的图片上传请求

#### `check_image_in_mitm.cjs`
统计 MITM 日志中的图片请求

#### `analyze_image_issue.cjs`
对比不同日期的图片请求情况

#### `inspect_latest_image.cjs`
检查最近一条图片请求的详细格式

#### `dump_image_payload.cjs`
导出完整的图片请求 payload 供深度分析

---

### 🧪 测试工具

#### `test_vision_api.cjs`
直接测试上游 API 的 vision 能力

**使用方法**:
```bash
$env:TEST_API_BASE = "https://muyuan.do"
$env:TEST_API_KEY = "sk-..."
$env:TEST_MODEL = "claude-opus-4-6"
node scripts\test_vision_api.cjs
```

---

## 🎯 典型使用场景

### 场景 1: 用户报告图片理解不工作

```bash
# 1. 检查历史
node scripts\find_real_image_request.cjs

# 2. 分析问题
node scripts\analyze_image_issue.cjs

# 3. 修复配置
node scripts\fix_vision_capability.cjs "君の公益"
```

---

## 📚 相关文档

- **详细调研报告**: `../调研报告-图片理解问题-20260608.md`
- **快速参考**: `../图片问题-快速参考.md`
