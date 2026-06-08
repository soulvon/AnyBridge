#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试 API: https://a-ocnfniawgw.cn-shanghai.fcapp.run
"""
import urllib.request
import urllib.error
import json

API_BASE = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
API_KEY = "sk-zgYHlvtuzpa5Y8QfFTX3YiB06UKJ6TgtfeBfs9jYPKUWV8CZ"

def make_request(endpoint, payload=None, method="GET", stream=False):
    """发送请求并返回结果"""
    url = f"{API_BASE}{endpoint}"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    
    if stream:
        headers["Accept"] = "text/event-stream"
    
    try:
        if payload:
            data = json.dumps(payload).encode('utf-8')
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
        else:
            req = urllib.request.Request(url, headers=headers, method=method)
        
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.read().decode('utf-8', errors='ignore')[:200]}"}
    except Exception as e:
        return {"error": str(e)}

def test_models():
    """测试获取模型列表"""
    print("=" * 50)
    print("1. 获取模型列表")
    print("=" * 50)
    result = make_request("/v1/models")
    if "error" in result:
        print(f"[X] 失败: {result['error']}")
        return []
    models = result.get("data", [])
    print(f"[OK] 成功，共 {len(models)} 个模型")
    for m in models[:10]:
        print(f"  - {m.get('id', 'unknown')}")
    return models

def test_chat(model="gpt-4o-mini"):
    """测试普通对话"""
    print("\n" + "=" * 50)
    print(f"2. 测试普通对话 ({model})")
    print("=" * 50)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "你好，请用一句话介绍自己"}],
        "max_tokens": 100
    }
    result = make_request("/v1/chat/completions", payload, "POST")
    if "error" in result:
        print(f"[X] 失败: {result['error']}")
        return False
    content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    print(f"[OK] 成功")
    print(f"  回复: {content[:100]}...")
    return True

def test_tool_calling(model="gpt-4o-mini"):
    """测试工具调用"""
    print("\n" + "=" * 50)
    print(f"3. 测试工具调用 ({model})")
    print("=" * 50)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "上海天气怎么样"}],
        "tools": [{
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "获取指定城市的天气信息",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "city": {"type": "string", "description": "城市名称"}
                    },
                    "required": ["city"]
                }
            }
        }],
        "tool_choice": "auto"
    }
    result = make_request("/v1/chat/completions", payload, "POST")
    if "error" in result:
        print(f"[X] 失败: {result['error']}")
        return False
    
    choice = result.get("choices", [{}])[0]
    finish_reason = choice.get("finish_reason", "")
    tool_calls = choice.get("message", {}).get("tool_calls", [])
    
    if tool_calls:
        print(f"[OK] 成功触发工具调用")
        print(f"  finish_reason: {finish_reason}")
        for tc in tool_calls:
            print(f"  函数: {tc.get('function', {}).get('name')}")
            print(f"  参数: {tc.get('function', {}).get('arguments', '')}")
        return True
    else:
        content = choice.get("message", {}).get("content", "")
        print(f"[!] 未触发工具调用，模型直接回复:")
        print(f"  {content[:100]}...")
        return False

def test_vision(model="gpt-4o-mini"):
    """测试图片理解"""
    print("\n" + "=" * 50)
    print(f"4. 测试图片理解 ({model})")
    print("=" * 50)
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "描述这张图片"},
                {"type": "image_url", "image_url": {"url": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Full_Moon_Luc_Viatour.jpg/600px-Full_Moon_Luc_Viatour.jpg"}}
            ]
        }],
        "max_tokens": 200
    }
    result = make_request("/v1/chat/completions", payload, "POST")
    if "error" in result:
        print(f"[X] 失败: {result['error']}")
        return False
    content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    print(f"[OK] 成功")
    print(f"  描述: {content[:150]}...")
    return True

def test_stream(model="gpt-4o-mini"):
    """测试流式输出"""
    print("\n" + "=" * 50)
    print(f"5. 测试流式输出 ({model})")
    print("=" * 50)
    url = f"{API_BASE}/v1/chat/completions"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "你好"}],
        "stream": True,
        "max_tokens": 50
    }
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    
    try:
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=30) as response:
            print(f"[OK] 连接成功，状态: {response.status}")
            chunks = 0
            for line in response:
                line = line.decode('utf-8').strip()
                if line.startswith("data: "):
                    chunks += 1
                    if chunks <= 3:
                        print(f"  数据块 {chunks}: {line[:80]}...")
            print(f"  共收到 {chunks} 个数据块")
            return True
    except Exception as e:
        print(f"[X] 失败: {e}")
        return False

if __name__ == "__main__":
    print("\n" + "=" * 50)
    print(f" 测试 API: {API_BASE}")
    print("=" * 50)
    
    models = test_models()
    
    # 尝试找一个可用的模型
    test_model = "gpt-4o-mini"
    if models:
        test_model = models[0].get("id", "gpt-4o-mini")
    
    test_chat(test_model)
    test_tool_calling(test_model)
    test_vision(test_model)
    test_stream(test_model)
    
    print("\n" + "=" * 50)
    print(" 测试完成")
    print("=" * 50)
