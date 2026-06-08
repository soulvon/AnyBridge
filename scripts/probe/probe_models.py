"""Get full model list from the proxy."""
import urllib.request
import ssl
import json

BASE = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
KEY = "sk-zgYHlvtuzpa5Y8QfFTX3YiB06UKJ6TgtfeBfs9jYPKUWV8CZ"

ctx = ssl.create_default_context()
req = urllib.request.Request(
    f"{BASE}/v1/models",
    headers={"authorization": f"Bearer {KEY}"},
)
with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
    data = json.loads(resp.read().decode())

models = [m["id"] for m in data.get("data", [])]
models.sort()
print(f"Total models: {len(models)}")
for m in models:
    print(f"  - {m}")

# Now test with a valid model from the list
print()
print("=" * 60)
if models:
    test_model = models[0]
    print(f"Testing Anthropic format with model: {test_model}")
    print("=" * 60)
    body = json.dumps({
        "model": test_model,
        "max_tokens": 10,
        "messages": [{"role": "user", "content": "say hi"}],
    }).encode()
    req2 = urllib.request.Request(
        f"{BASE}/v1/messages",
        data=body,
        headers={
            "content-type": "application/json",
            "x-api-key": KEY,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req2, timeout=30, context=ctx) as resp:
            print(f"  Status: {resp.status}")
            print(f"  Body: {resp.read().decode()[:1000]}")
    except urllib.error.HTTPError as e:
        print(f"  Status: {e.code}")
        print(f"  Body: {e.read().decode()[:1000]}")
