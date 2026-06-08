"""Probe: try to find the exact mechanism for 'enabling 1m context'.
Claude Code must send something we're missing. Let's try:
1. The actual Claude Code SDK headers
2. Specific body parameters like 'context_window', 'extended_context', etc.
3. Check if the proxy responds to specific request patterns
"""
import urllib.request
import urllib.error
import ssl
import json

BASE = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
KEY = "sk-zgYHlvtuzpa5Y8QfFTX3YiB06UKJ6TgtfeBfs9jYPKUWV8CZ"
ctx = ssl.create_default_context()

def test(desc, model="claude-sonnet-4-20250514", extra_body=None, extra_headers=None, path="/v1/messages"):
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
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(f"{BASE}{path}", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            return resp.status, resp.read().decode()[:300]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

# ── Test: extended context body params ──
print("=" * 70)
print("Extended context body parameters")
print("=" * 70)
body_params = [
    {"context_window": 1000000},
    {"context_window_size": 1000000},
    {"extended_context": True},
    {"extended_context": "1m"},
    {"enable_1m_context": True},
    {"context_length": 1000000},
    {"max_context": 1000000},
    {"thinking": {"type": "enabled", "budget_tokens": 10000}},
    {"thinking": {"type": "enabled", "budget_tokens": 10000}, "extended_context": True},
]
for bp in body_params:
    status, body = test(f"body+{list(bp.keys())}", extra_body=bp)
    tag = "✅" if status == 200 else "❌"
    print(f"  {str(bp)[:60]:60s} → {tag} {status} {body[:80]}")

# ── Test: specific x- headers that Claude Code might send ──
print()
print("=" * 70)
print("Custom x- headers that Claude Code might send")
print("=" * 70)
x_headers = [
    {"x-api-key": KEY, "x-enable-1m": "true"},
    {"x-api-key": KEY, "x-extended-context": "true"},
    {"x-api-key": KEY, "x-context-window": "1000000"},
    {"x-api-key": KEY, "x-client-name": "claude-code"},
    {"x-api-key": KEY, "x-client-version": "1.0.0"},
    {"x-api-key": KEY, "x-product": "claude-code"},
    {"x-api-key": KEY, "x-source": "claude-code-cli"},
    # Authorization Bearer instead of x-api-key
    {"authorization": f"Bearer {KEY}"},
    # Both
    {"x-api-key": KEY, "authorization": f"Bearer {KEY}"},
]
for xh in x_headers:
    desc = str({k: (v[:20] + '...' if isinstance(v, str) and len(v) > 20 else v) for k, v in xh.items()})
    status, body = test(desc[:60], extra_headers=xh)
    tag = "✅" if status == 200 else "❌"
    print(f"  {desc[:60]:60s} → {tag} {status} {body[:80]}")

# ── Test: streaming vs non-streaming ──
print()
print("=" * 70)
print("Streaming mode (stream: true)")
print("=" * 70)
status, body = test("stream=true", extra_body={"stream": True}, extra_headers={"accept": "text/event-stream"})
tag = "✅" if status == 200 else "❌"
print(f"  stream=true → {tag} {status} {body[:200]}")

# ── Test: the model name with [1m] as-is ──
print()
print("=" * 70)
print("Model name with [1m] suffix as-is")
print("=" * 70)
m1m_variants = [
    "claude-opus-4-8[1m]",
    "claude-sonnet-4-20250514[1m]",
    "claude-sonnet-4-5-20250929[1m]",
    "claude-opus-4-7[1m]",
]
for m in m1m_variants:
    status, body = test(m, model=m)
    tag = "✅" if status == 200 else "❌"
    print(f"  {m:40s} → {tag} {status} {body[:120]}")

# ── Test: OpenAI /v1/responses with GPT models + streaming ──
print()
print("=" * 70)
print("GPT models via /v1/responses (non-streaming)")
print("=" * 70)
for m in ["gpt-5-codex", "gpt-5.5"]:
    body_dict = {
        "model": m,
        "input": [{"role": "user", "content": "say hi"}],
        "stream": False,
    }
    body = json.dumps(body_dict).encode()
    req = urllib.request.Request(f"{BASE}/v1/responses", data=body, headers={
        "content-type": "application/json",
        "authorization": f"Bearer {KEY}",
    }, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            print(f"  {m}: ✅ {resp.status} — {resp.read().decode()[:150]}")
    except urllib.error.HTTPError as e:
        print(f"  {m}: ❌ {e.code} — {e.read().decode()[:150]}")
