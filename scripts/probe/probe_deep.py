"""Deep probe: figure out how Claude Code handles the [1m] model suffix.
The proxy says '1m 上下文已经全量可用，请启用 1m 上下文后重试' for ALL UAs.
This means the [1m] is NOT a model name suffix — it's a signal that the 
proxy REQUIRES some specific parameter to enable 1M context.
"""
import urllib.request
import urllib.error
import ssl
import json

BASE = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
KEY = "sk-zgYHlvtuzpa5Y8QfFTX3YiB06UKJ6TgtfeBfs9jYPKUWV8CZ"
ctx = ssl.create_default_context()

def test_request(desc, model, extra_body=None, extra_headers=None):
    body_dict = {
        "model": model,
        "max_tokens": 10,
        "stream": False,
        "messages": [{"role": "user", "content": "say hi"}],
    }
    if extra_body:
        body_dict.update(extra_body)
    body = json.dumps(body_dict).encode()
    headers = {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-code/1.0.0",
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(f"{BASE}/v1/messages", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            return resp.status, resp.read().decode()[:300]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

# ── Hypothesis 1: [1m] means max_tokens needs to be larger ──
print("=" * 70)
print("H1: Does the proxy require max_tokens >= some threshold?")
print("=" * 70)
for mt in [10, 256, 1024, 4096, 8192, 16384, 32768, 65536, 128000, 1048576]:
    status, body = test_request(f"max_tokens={mt}", "claude-sonnet-4-20250514", {"max_tokens": mt})
    tag = "✅" if status == 200 else "❌"
    print(f"  max_tokens={mt:7d} → {tag} {status} {body[:100]}")

# ── Hypothesis 2: The model name needs [1m] stripped + some context param ──
print()
print("=" * 70)
print("H2: Model name variations (strip [1m], add context params)")
print("=" * 70)
model_variants = [
    "claude-sonnet-4-20250514",
    "claude-sonnet-4-20250514-1m",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-8",
    "claude-opus-4-8-1m",
]
for m in model_variants:
    status, body = test_request(m, m)
    tag = "✅" if status == 200 else "❌"
    print(f"  {m:40s} → {tag} {status} {body[:120]}")

# ── Hypothesis 3: Need anthropic-version >= some newer date ──
print()
print("=" * 70)
print("H3: anthropic-version header variations")
print("=" * 70)
versions = [
    "2023-06-01",
    "2024-01-01",
    "2024-04-01",
    "2024-10-22",
    "2025-01-01",
    "2025-04-01",
    "2025-04-14",
]
for v in versions:
    status, body = test_request(f"version={v}", "claude-sonnet-4-20250514", extra_headers={"anthropic-version": v})
    tag = "✅" if status == 200 else "❌"
    print(f"  anthropic-version={v:20s} → {tag} {status} {body[:120]}")

# ── Hypothesis 4: Need specific anthropic-beta for extended context ──
print()
print("=" * 70)
print("H4: anthropic-beta header for extended/1M context")
print("=" * 70)
betas = [
    "prompt-caching-2024-07-31",
    "max-tokens-3-5-sonnet-2024-10-22",
    "interleaved-thinking-2025-05-14",
    "extended-cache-ttl-2025-04-11",
    "output-128k-2025-02-19",
    "pdfs-2024-09-25",
    "token-counting-2024-11-01",
    "analysis-tool-2025-04-15",
    # Comma-separated combinations
    "prompt-caching-2024-07-31,max-tokens-3-5-sonnet-2024-10-22",
    "prompt-caching-2024-07-31,interleaved-thinking-2025-05-14",
    "max-tokens-3-5-sonnet-2024-10-22,interleaved-thinking-2025-05-14",
]
for b in betas:
    status, body = test_request(f"beta={b[:40]}", "claude-sonnet-4-20250514", extra_headers={"anthropic-beta": b})
    tag = "✅" if status == 200 else "❌"
    print(f"  beta={b[:60]:60s} → {tag} {status} {body[:120]}")

# ── Hypothesis 5: The working model (haiku-4-5) works because it doesn't need 1m ──
print()
print("=" * 70)
print("H5: Which models work WITHOUT 1m context?")
print("=" * 70)
models = [
    "claude-3-5-haiku-20241022",
    "claude-haiku-4-5-20251001",
]
for m in models:
    status, body = test_request(m, m)
    tag = "✅" if status == 200 else "❌"
    print(f"  {m:40s} → {tag} {status} {body[:120]}")
