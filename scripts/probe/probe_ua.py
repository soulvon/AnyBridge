"""Test UA-based access control on the proxy endpoint."""
import urllib.request
import urllib.error
import ssl
import json

BASE = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
KEY = "sk-zgYHlvtuzpa5Y8QfFTX3YiB06UKJ6TgtfeBfs9jYPKUWV8CZ"
MODEL = "claude-sonnet-4-20250514"
ctx = ssl.create_default_context()

# The model with [1m] suffix as used in Claude Code config
MODEL_1M = "claude-opus-4-8[1m]"

ua_list = [
    # Claude Code CLI UA (the real one)
    ("Claude Code CLI", "claude-code/1.0.0"),
    # Common variations
    ("Claude-Code", "Claude-Code/1.0.0"),
    ("Anthropic SDK Python", "anthropic-python/0.49.0"),
    ("Anthropic SDK Node", "anthropic-node/0.52.0"),
    ("OpenAI SDK Python", "openai-python/1.55.0"),
    ("Python urllib", "Python-urllib/3.11"),
    ("Node https", "node"),
    ("curl", "curl/8.7.1"),
    ("Empty UA", ""),
    ("No UA header", None),
    ("Browser Chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"),
    ("Codex CLI", "codex-cli/1.0.0"),
]

def test_ua(label, ua, model=MODEL, use_anthropic=True):
    """Test with specific User-Agent."""
    body_dict = {
        "model": model,
        "max_tokens": 10,
        "stream": False,
        "messages": [{"role": "user", "content": "say hi"}],
    }
    body = json.dumps(body_dict).encode()
    headers = {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
    }
    if ua is not None:
        headers["user-agent"] = ua
    # else: don't set User-Agent at all

    path = "/v1/messages"
    req = urllib.request.Request(f"{BASE}{path}", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            result = resp.read().decode()[:200]
            return resp.status, result
    except urllib.error.HTTPError as e:
        result = e.read().decode()[:200]
        return e.code, result
    except Exception as e:
        return -1, str(e)

# ── Phase 1: Test different UAs with standard model ──
print("=" * 70)
print("PHASE 1: Different User-Agents with model=claude-sonnet-4-20250514")
print("=" * 70)
for label, ua in ua_list:
    status, body = test_ua(label, ua, MODEL)
    # Summarize result
    if status == 200:
        summary = "✅ SUCCESS"
    elif status == 400 and "1m" in body:
        summary = "❌ 400 — 需要1m上下文"
    elif status == 400 and "下线" in body:
        summary = "❌ 400 — 模型下线"
    elif status == 429:
        summary = "⚠️  429 — 限流/不可用"
    elif status == 404:
        summary = "❌ 404 — 不支持"
    else:
        summary = f"❌ {status}"
    print(f"  {label:30s} → {summary}")
    if status == 200:
        print(f"    Body: {body[:150]}")

# ── Phase 2: Test with [1m] model suffix ──
print()
print("=" * 70)
print("PHASE 2: Different User-Agents with model=claude-opus-4-8[1m]")
print("=" * 70)
for label, ua in ua_list:
    status, body = test_ua(label, ua, MODEL_1M)
    if status == 200:
        summary = "✅ SUCCESS"
    elif status == 400 and "1m" in body:
        summary = "❌ 400 — 需要1m上下文"
    elif status == 400 and "下线" in body:
        summary = "❌ 400 — 模型下线"
    elif status == 429:
        summary = "⚠️  429 — 限流/不可用"
    elif status == 404:
        summary = "❌ 404 — 不支持"
    else:
        summary = f"❌ {status}"
    print(f"  {label:30s} → {summary}")
    if status == 200:
        print(f"    Body: {body[:150]}")

# ── Phase 3: Test Claude Code specific headers ──
print()
print("=" * 70)
print("PHASE 3: Claude Code specific header combinations")
print("=" * 70)

# Claude Code sends additional headers
extra_headers_tests = [
    ("x-api-key only (no extra)", {}),
    ("+ anthropic-beta: prompt-caching", {"anthropic-beta": "prompt-caching-2024-07-31"}),
    ("+ anthropic-beta: max-tokens", {"anthropic-beta": "max-tokens-3-5-sonnet-2024-10-22"}),
    ("+ anthropic-beta: extended-context", {"anthropic-beta": "extended-context-2025-01-01"}),
    ("+ x-claude-code-version", {"x-claude-code-version": "1.0.0"}),
    ("+ x-client: claude-code", {"x-client": "claude-code"}),
]

for desc, extra in extra_headers_tests:
    body_dict = {
        "model": MODEL,
        "max_tokens": 10,
        "stream": False,
        "messages": [{"role": "user", "content": "say hi"}],
    }
    body = json.dumps(body_dict).encode()
    headers = {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-code/1.0.0",
    }
    headers.update(extra)
    req = urllib.request.Request(f"{BASE}/v1/messages", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            status = resp.status
            result = resp.read().decode()[:200]
    except urllib.error.HTTPError as e:
        status = e.code
        result = e.read().decode()[:200]
    if status == 200:
        summary = "✅ SUCCESS"
    elif status == 400 and "1m" in result:
        summary = "❌ 400 — 需要1m上下文"
    else:
        summary = f"❌ {status}"
    print(f"  {desc:45s} → {summary}")
    if status == 200:
        print(f"    Body: {result[:150]}")

# ── Phase 4: Test [1m] model with Claude Code UA ──
print()
print("=" * 70)
print("PHASE 4: model=claude-opus-4-8[1m] + Claude Code UA + extra headers")
print("=" * 70)
for desc, extra in extra_headers_tests:
    body_dict = {
        "model": MODEL_1M,
        "max_tokens": 10,
        "stream": False,
        "messages": [{"role": "user", "content": "say hi"}],
    }
    body = json.dumps(body_dict).encode()
    headers = {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-code/1.0.0",
    }
    headers.update(extra)
    req = urllib.request.Request(f"{BASE}/v1/messages", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            status = resp.status
            result = resp.read().decode()[:200]
    except urllib.error.HTTPError as e:
        status = e.code
        result = e.read().decode()[:200]
    if status == 200:
        summary = "✅ SUCCESS"
    elif status == 400 and "1m" in result:
        summary = "❌ 400 — 需要1m上下文"
    else:
        summary = f"❌ {status}"
    print(f"  {desc:45s} → {summary}")
    if status == 200:
        print(f"    Body: {result[:150]}")
