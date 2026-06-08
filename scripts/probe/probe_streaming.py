"""Test streaming and different auth/header combos on the proxy."""
import urllib.request
import ssl
import json

BASE = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
KEY = "sk-zgYHlvtuzpa5Y8QfFTX3YiB06UKJ6TgtfeBfs9jYPKUWV8CZ"
MODEL = "claude-3-5-haiku-20241022"

ctx = ssl.create_default_context()

# Test 1: Anthropic streaming with x-api-key
print("=" * 60)
print("1) Anthropic STREAMING: /v1/messages + x-api-key + stream:true")
print("=" * 60)
body = json.dumps({
    "model": MODEL,
    "max_tokens": 10,
    "stream": True,
    "messages": [{"role": "user", "content": "say hi"}],
}).encode()
req = urllib.request.Request(
    f"{BASE}/v1/messages",
    data=body,
    headers={
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
        "accept": "text/event-stream",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  Status: {resp.status}")
        print(f"  Content-Type: {resp.headers.get('content-type')}")
        chunk = resp.read(2000).decode()
        print(f"  First 500 chars: {chunk[:500]}")
except urllib.error.HTTPError as e:
    print(f"  Status: {e.code}")
    print(f"  Body: {e.read().decode()[:500]}")

# Test 2: Anthropic non-streaming with Bearer auth
print()
print("=" * 60)
print("2) Anthropic NON-streaming: /v1/messages + Bearer")
print("=" * 60)
body = json.dumps({
    "model": MODEL,
    "max_tokens": 10,
    "stream": False,
    "messages": [{"role": "user", "content": "say hi"}],
}).encode()
req = urllib.request.Request(
    f"{BASE}/v1/messages",
    data=body,
    headers={
        "content-type": "application/json",
        "authorization": f"Bearer {KEY}",
        "anthropic-version": "2023-06-01",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  Status: {resp.status}")
        print(f"  Body: {resp.read().decode()[:500]}")
except urllib.error.HTTPError as e:
    print(f"  Status: {e.code}")
    print(f"  Body: {e.read().decode()[:500]}")

# Test 3: Without anthropic-version header
print()
print("=" * 60)
print("3) Anthropic WITHOUT anthropic-version header")
print("=" * 60)
body = json.dumps({
    "model": MODEL,
    "max_tokens": 10,
    "stream": False,
    "messages": [{"role": "user", "content": "say hi"}],
}).encode()
req = urllib.request.Request(
    f"{BASE}/v1/messages",
    data=body,
    headers={
        "content-type": "application/json",
        "x-api-key": KEY,
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  Status: {resp.status}")
        print(f"  Body: {resp.read().decode()[:500]}")
except urllib.error.HTTPError as e:
    print(f"  Status: {e.code}")
    print(f"  Body: {e.read().decode()[:500]}")

# Test 4: OpenAI /v1/responses endpoint (new Responses API)
print()
print("=" * 60)
print("4) OpenAI Responses API: POST /v1/responses + Bearer")
print("=" * 60)
body = json.dumps({
    "model": MODEL,
    "input": [{"role": "user", "content": "say hi"}],
    "stream": True,
}).encode()
req = urllib.request.Request(
    f"{BASE}/v1/responses",
    data=body,
    headers={
        "content-type": "application/json",
        "authorization": f"Bearer {KEY}",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  Status: {resp.status}")
        print(f"  Body: {resp.read().decode()[:500]}")
except urllib.error.HTTPError as e:
    print(f"  Status: {e.code}")
    print(f"  Body: {e.read().decode()[:500]}")
