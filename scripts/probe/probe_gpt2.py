"""Test GPT models with proper Responses API format and streaming."""
import urllib.request
import ssl
import json

BASE = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
KEY = "sk-zgYHlvtuzpa5Y8QfFTX3YiB06UKJ6TgtfeBfs9jYPKUWV8CZ"
ctx = ssl.create_default_context()

# GPT-5-codex via Responses API with proper format
print("=" * 60)
print("1) gpt-5-codex via /v1/responses (streaming)")
print("=" * 60)
body = json.dumps({
    "model": "gpt-5-codex",
    "input": [{"role": "user", "content": "say hi"}],
    "stream": True,
}).encode()
req = urllib.request.Request(f"{BASE}/v1/responses", data=body, headers={
    "content-type": "application/json",
    "authorization": f"Bearer {KEY}",
    "accept": "text/event-stream",
}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  Status: {resp.status}")
        print(f"  Content-Type: {resp.headers.get('content-type')}")
        data = resp.read(3000).decode()
        print(f"  First 1000 chars: {data[:1000]}")
except urllib.error.HTTPError as e:
    print(f"  Status: {e.code}")
    print(f"  Body: {e.read().decode()[:500]}")

# gpt-5.5 via Responses API with proper format
print()
print("=" * 60)
print("2) gpt-5.5 via /v1/responses (streaming)")
print("=" * 60)
body = json.dumps({
    "model": "gpt-5.5",
    "input": [{"role": "user", "content": "say hi"}],
    "stream": True,
}).encode()
req = urllib.request.Request(f"{BASE}/v1/responses", data=body, headers={
    "content-type": "application/json",
    "authorization": f"Bearer {KEY}",
    "accept": "text/event-stream",
}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  Status: {resp.status}")
        print(f"  Content-Type: {resp.headers.get('content-type')}")
        data = resp.read(3000).decode()
        print(f"  First 1000 chars: {data[:1000]}")
except urllib.error.HTTPError as e:
    print(f"  Status: {e.code}")
    print(f"  Body: {e.read().decode()[:500]}")

# gemini-2.5-pro via Responses API
print()
print("=" * 60)
print("3) gemini-2.5-pro via /v1/responses (streaming)")
print("=" * 60)
body = json.dumps({
    "model": "gemini-2.5-pro",
    "input": [{"role": "user", "content": "say hi"}],
    "stream": True,
}).encode()
req = urllib.request.Request(f"{BASE}/v1/responses", data=body, headers={
    "content-type": "application/json",
    "authorization": f"Bearer {KEY}",
    "accept": "text/event-stream",
}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  Status: {resp.status}")
        print(f"  Content-Type: {resp.headers.get('content-type')}")
        data = resp.read(3000).decode()
        print(f"  First 1000 chars: {data[:1000]}")
except urllib.error.HTTPError as e:
    print(f"  Status: {e.code}")
    print(f"  Body: {e.read().decode()[:500]}")

# gemini-2.5-pro via chat/completions
print()
print("=" * 60)
print("4) gemini-2.5-pro via /v1/chat/completions")
print("=" * 60)
body = json.dumps({
    "model": "gemini-2.5-pro",
    "max_tokens": 10,
    "messages": [{"role": "user", "content": "say hi"}],
}).encode()
req = urllib.request.Request(f"{BASE}/v1/chat/completions", data=body, headers={
    "content-type": "application/json",
    "authorization": f"Bearer {KEY}",
}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        print(f"  Status: {resp.status}")
        print(f"  Body: {resp.read().decode()[:500]}")
except urllib.error.HTTPError as e:
    print(f"  Status: {e.code}")
    print(f"  Body: {e.read().decode()[:500]}")
