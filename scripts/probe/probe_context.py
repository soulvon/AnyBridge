"""Test the '1m context' requirement - try various headers/params."""
import urllib.request
import ssl
import json

BASE = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
KEY = "sk-zgYHlvtuzpa5Y8QfFTX3YiB06UKJ6TgtfeBfs9jYPKUWV8CZ"
MODEL = "claude-sonnet-4-20250514"
ctx = ssl.create_default_context()

def test_anthropic(desc, extra_headers=None, extra_body=None):
    body_dict = {
        "model": MODEL,
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
    req = urllib.request.Request(f"{BASE}/v1/messages", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            result = resp.read().decode()[:300]
            print(f"  {desc}: {resp.status} — {result}")
    except urllib.error.HTTPError as e:
        result = e.read().decode()[:300]
        print(f"  {desc}: {e.code} — {result}")

# Test with different anthropic-version values
test_anthropic("version 2023-06-01")
test_anthropic("version 2024-10-22", {"anthropic-version": "2024-10-22"})
test_anthropic("version 2025-01-01", {"anthropic-version": "2025-01-01"})
test_anthropic("version 2025-04-14", {"anthropic-version": "2025-04-14"})

# Test with extended context / max_tokens variations
test_anthropic("max_tokens=8192", None, {"max_tokens": 8192})
test_anthropic("max_tokens=128000", None, {"max_tokens": 128000})

# Test with max_tokens but no stream
test_anthropic("no stream field", None, {"stream": None})

# Try with anthropic-beta header for extended context
test_anthropic("beta max-tokens-3-5-sonnet", {"anthropic-beta": "max-tokens-3-5-sonnet-2024-10-22"})
test_anthropic("beta extended-context", {"anthropic-beta": "extended-context-2025-01-01"})
test_anthropic("beta prompt-caching", {"anthropic-beta": "prompt-caching-2024-07-31"})

# Try with model that might work (opus-4-7)
print()
print("--- Testing claude-opus-4-7 ---")
body = json.dumps({
    "model": "claude-opus-4-7",
    "max_tokens": 10,
    "stream": False,
    "messages": [{"role": "user", "content": "say hi"}],
}).encode()
req = urllib.request.Request(f"{BASE}/v1/messages", data=body, headers={
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  opus-4-7: {resp.status} — {resp.read().decode()[:300]}")
except urllib.error.HTTPError as e:
    print(f"  opus-4-7: {e.code} — {e.read().decode()[:300]}")

# Try gemini model
print()
print("--- Testing gemini-2.5-pro ---")
body = json.dumps({
    "model": "gemini-2.5-pro",
    "max_tokens": 10,
    "stream": False,
    "messages": [{"role": "user", "content": "say hi"}],
}).encode()
req = urllib.request.Request(f"{BASE}/v1/messages", data=body, headers={
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  gemini: {resp.status} — {resp.read().decode()[:300]}")
except urllib.error.HTTPError as e:
    print(f"  gemini: {e.code} — {e.read().decode()[:300]}")
