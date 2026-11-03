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

# 2) 逐文件上传：删同名资产 → 上传；失败的文件单独进入重试队列。
#
# 为什么不再整批上传：31 个文件一次性 `gh release upload`，任何一个文件失败都会
# 让整批判失败，下一轮重试又会把已成功的安装包全部删掉重传。v1.0.13、v1.0.14
# 连续两版都是「19 个安装包反复成功、latest.json 反复 404（7 次）」，10 轮重试
# 全撞同一个文件后整批失败，最终要人工补传 9 个 manifest。
#
# 逐文件隔离后：单文件失败不回滚已成功的，重试只针对失败的文件；删除与同名重传
# 之间留 3 秒，避开资产删除在 uploads 端点的收敛窗口。
upload_one() {
  local f="$1" wait_after_delete="$2" base
  base="$(basename "$f")"
  gh release delete-asset "$TAG" --repo "$REPO" "$base" --yes 2>/dev/null || true
  if [ "$wait_after_delete" -gt 0 ]; then
    sleep "$wait_after_delete"
  fi
  gh release upload "$TAG" --repo "$REPO" "$f"
}

pending=("${FILES[@]}")
for attempt in $(seq 1 5); do
  wait_after_delete=0
  if [ "$attempt" -gt 1 ]; then
    wait_after_delete=3
  fi
  remaining=()
  for f in "${pending[@]}"; do
    if upload_one "$f" "$wait_after_delete"; then
      echo "已上传: $(basename "$f")（第 $attempt 轮）"
    else
      echo "::warning::上传失败，进入重试队列: $(basename "$f")"
      remaining+=("$f")
    fi
  done
  pending=("${remaining[@]}")
  if [ ${#pending[@]} -eq 0 ]; then
    echo "已全部上传 ${#FILES[@]} 个资产到 $REPO:$TAG"
    exit 0
  fi
  wait_secs=$((attempt * 15))
  if [ "$attempt" -lt 5 ]; then
    echo "::warning::${#pending[@]} 个资产上传失败，${wait_secs} 秒后第 $((attempt + 1))/5 轮重试"
    sleep "$wait_secs"
  fi
done

echo "::error::以下资产重试 5 轮仍失败: $(printf '%s ' "${pending[@]}")"
exit 1
