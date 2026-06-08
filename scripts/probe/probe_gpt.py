"""Test GPT and other non-Claude models on the proxy."""
import urllib.request
import ssl
import json

BASE = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
KEY = "sk-zgYHlvtuzpa5Y8QfFTX3YiB06UKJ6TgtfeBfs9jYPKUWV8CZ"
ctx = ssl.create_default_context()

# First get the full model list again
req = urllib.request.Request(f"{BASE}/v1/models", headers={"authorization": f"Bearer {KEY}"})
with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
    data = json.loads(resp.read().decode())
models = sorted([m["id"] for m in data.get("data", [])])
print("Available models:")
for m in models:
    print(f"  - {m}")

# Test each model with Anthropic format
print("\n" + "=" * 60)
print("Testing each model via Anthropic format (/v1/messages)")
print("=" * 60)
for model in models:
    body = json.dumps({
        "model": model,
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
            print(f"  {model}: {resp.status} — {resp.read().decode()[:200]}")
    except urllib.error.HTTPError as e:
        print(f"  {model}: {e.code} — {e.read().decode()[:200]}")

# Test GPT models with OpenAI chat completions format
print("\n" + "=" * 60)
print("Testing GPT models via OpenAI format (/v1/chat/completions)")
print("=" * 60)
gpt_models = [m for m in models if 'gpt' in m.lower()]
for model in gpt_models:
    body = json.dumps({
        "model": model,
        "max_tokens": 10,
        "messages": [{"role": "user", "content": "say hi"}],
    }).encode()
    req = urllib.request.Request(f"{BASE}/v1/chat/completions", data=body, headers={
        "content-type": "application/json",
        "authorization": f"Bearer {KEY}",
    }, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            print(f"  {model}: {resp.status} — {resp.read().decode()[:200]}")
    except urllib.error.HTTPError as e:
        print(f"  {model}: {e.code} — {e.read().decode()[:200]}")

# Test GPT models with OpenAI Responses API
print("\n" + "=" * 60)
print("Testing GPT models via Responses API (/v1/responses)")
print("=" * 60)
for model in gpt_models:
    body = json.dumps({
        "model": model,
        "input": [{"role": "user", "content": "say hi"}],
        "stream": False,
    }).encode()
    req = urllib.request.Request(f"{BASE}/v1/responses", data=body, headers={
        "content-type": "application/json",
        "authorization": f"Bearer {KEY}",
    }, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            print(f"  {model}: {resp.status} — {resp.read().decode()[:200]}")
    except urllib.error.HTTPError as e:
        print(f"  {model}: {e.code} — {e.read().decode()[:200]}")
