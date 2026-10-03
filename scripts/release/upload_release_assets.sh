#!/usr/bin/env bash
#
# 上传资产到 GitHub Release（带就绪等待与有限重试）。
#
# 为什么不直接用裸 `gh release upload --clobber`：
#   1. release 刚 create 完的几秒内，uploads.github.com 端点存在瞬时不一致，
#      立即上传会 HTTP 404（v0.5.26 发布时踩到，release id 正确但上传被拒）；
#   2. --clobber 内部先 GET 资产列表再逐个 DELETE，列表缓存过时时会因
#      "删除不存在的资产"而 404 中断（v0.5.25 手动重跑时踩到）。
#
# 本脚本统一：先等 release 在 API 侧可见，再对上传做有限次重试，
# 把这类瞬时故障吸收掉，避免发布流程因瞬时不一致而中断。
#
# 用法: upload_release_assets.sh <tag> <repo> <file...>

set -uo pipefail

TAG="${1:-}"
REPO="${2:-}"
shift 2 || true

if [ -z "$TAG" ] || [ -z "$REPO" ] || [ "$#" -eq 0 ]; then
  echo "用法: upload_release_assets.sh <tag> <repo> <file...>" >&2
  exit 1
fi

FILES=()
for f in "$@"; do
  if [ -f "$f" ]; then
    FILES+=("$f")
  else
    echo "跳过不存在的文件: $f"
  fi
done

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "::error::没有任何可上传的文件: $*"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "::error::未找到 gh CLI，无法上传 Release 资产" >&2
  exit 1
fi

# 1) 等 release 在 API 侧可见（刚 create 时可能瞬时查不到）
READY=0
for i in $(seq 1 10); do
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    READY=1
    break
  fi
  echo "等待 release $REPO:$TAG 就绪（$i/10）..."
  sleep 6
done
if [ "$READY" -ne 1 ]; then
  echo "::error::release $REPO:$TAG 等待超时仍不可见"
  exit 1
fi

# 2) 上传重试（--clobber 保证幂等覆盖）
for attempt in $(seq 1 6); do
  if gh release upload "$TAG" --repo "$REPO" "${FILES[@]}" --clobber; then
    echo "已上传 ${#FILES[@]} 个资产到 $REPO:$TAG（第 $attempt 次尝试）"
    exit 0
  fi
  echo "::warning::$REPO:$TAG 资产上传失败（第 $attempt/6 次），12 秒后重试"
  sleep 12
done

echo "::error::$REPO:$TAG 资产上传重试 6 次仍失败"
exit 1
