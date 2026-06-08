"""Probe the proxy endpoint to understand what API format it supports."""
import urllib.request
import urllib.error
import json
import ssl

BASE = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
KEY = "sk-zgYHlvtuzpa5Y8QfFTX3YiB06UKJ6TgtfeBfs9jYPKUWV8CZ"

ctx = ssl.create_default_context()

def probe(method, path, headers, body=None):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            return resp.status, resp.read().decode()[:2000]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:2000]
    except Exception as e:
        return -1, str(e)

# 1) Test Anthropic format: /v1/messages with x-api-key
print("=" * 60)
print("1) Anthropic format: POST /v1/messages + x-api-key")
print("=" * 60)
status, body = probe("POST", "/v1/messages", {
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
}, {
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 10,
    "messages": [{"role": "user", "content": "hi"}],
})
print(f"  Status: {status}")
print(f"  Body: {body[:500]}")

# 2) Test OpenAI format: /v1/chat/completions with Authorization: Bearer
print()
print("=" * 60)
print("2) OpenAI format: POST /v1/chat/completions + Bearer")
print("=" * 60)
status, body = probe("POST", "/v1/chat/completions", {
    "content-type": "application/json",
    "authorization": f"Bearer {KEY}",
}, {
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 10,
    "messages": [{"role": "user", "content": "hi"}],
})
print(f"  Status: {status}")
print(f"  Body: {body[:500]}")

# 3) Test Anthropic format but with Authorization: Bearer (hybrid)
print()
print("=" * 60)
print("3) Anthropic path + Bearer auth (hybrid)")
print("=" * 60)
status, body = probe("POST", "/v1/messages", {
    "content-type": "application/json",
    "authorization": f"Bearer {KEY}",
    "anthropic-version": "2023-06-01",
}, {
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 10,
    "messages": [{"role": "user", "content": "hi"}],
})
print(f"  Status: {status}")
print(f"  Body: {body[:500]}")

# 4) Test root path
print()
print("=" * 60)
print("4) GET / (root)")
print("=" * 60)
status, body = probe("GET", "/", {})
print(f"  Status: {status}")
print(f"  Body: {body[:500]}")

# 5) Test /v1/models
print()
print("=" * 60)
print("5) GET /v1/models + Bearer")
print("=" * 60)
status, body = probe("GET", "/v1/models", {
    "authorization": f"Bearer {KEY}",
})
print(f"  Status: {status}")
print(f"  Body: {body[:500]}")
