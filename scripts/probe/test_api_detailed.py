#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""详细测试 muyuan.do API"""

import json
import urllib.request
import urllib.error

API_KEY = "sk-yQDLULvK2SF4FfXrgHGtiKXFD3gdySJD1fDchhQV1CRqMyPE"
API_URL = "https://muyuan.do/v1/chat/completions"

HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0"
}

def test_chat():
    """测试普通对话"""
    print("=" * 50)
    print("测试普通对话")
    print("=" * 50)
    
    payload = {
        "model": "claude-sonnet-4-6",
        "messages": [{"role": "user", "content": "你好，请简短回复"}]
    }
    
    try:
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers=HEADERS,
            method="POST"
        )
        
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
            print(f"响应状态: {result.get('object', 'N/A')}")
            print(f"模型: {result.get('model', 'N/A')}")
            print(f"回复: {result.get('choices', [{}])[0].get('message', {}).get('content', 'N/A')[:100]}...")
            print()
            
    except Exception as e:
        print(f"[X] 错误: {e}\n")

def test_tool_calling():
    """测试工具调用 - 详细版"""
    print("=" * 50)
    print("测试工具调用 (详细)")
    print("=" * 50)
    
    payload = {
        "model": "claude-sonnet-4-6",
        "messages": [{"role": "user", "content": "查询北京的天气"}],
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
    
    try:
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers=HEADERS,
            method="POST"
        )
        
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
            
            print(f"完整响应:")
            print(json.dumps(result, indent=2, ensure_ascii=False))
            print()
            
            choice = result.get('choices', [{}])[0]
            message = choice.get('message', {})
            tool_calls = message.get('tool_calls', [])
            finish_reason = choice.get('finish_reason', 'N/A')
            
            print(f"完成原因: {finish_reason}")
            print(f"工具调用数量: {len(tool_calls)}")
            
            if tool_calls:
                for i, tc in enumerate(tool_calls):
                    print(f"\n  工具调用 {i+1}:")
                    print(f"    ID: {tc.get('id', 'N/A')}")
                    print(f"    类型: {tc.get('type', 'N/A')}")
                    func = tc.get('function', {})
                    print(f"    函数名: {func.get('name', 'N/A')}")
                    print(f"    参数: {func.get('arguments', 'N/A')}")
            else:
                print(f"\n  回复内容: {message.get('content', 'N/A')}")
            print()
            
    except Exception as e:
        print(f"[X] 错误: {e}\n")

def test_vision():
    """测试图片理解 - 使用在线图片"""
    print("=" * 50)
    print("测试图片理解")
    print("=" * 50)
    
    # 尝试不同的图片URL
    test_urls = [
        ("picsum", "https://picsum.photos/400/300"),
        ("placeholder", "https://via.placeholder.com/400x300"),
        ("wikipedia", "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/300px-PNG_transparency_demonstration_1.png")
    ]
    
    for name, image_url in test_urls:
        print(f"\n尝试图片源: {name}")
        print(f"URL: {image_url}")
        
        payload = {
            "model": "claude-sonnet-4-6",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "描述图片"},
                        {"type": "image_url", "image_url": {"url": image_url}}
                    ]
                }
            ],
            "max_tokens": 500
        }
        
        try:
            req = urllib.request.Request(
                API_URL,
                data=json.dumps(payload).encode("utf-8"),
                headers=HEADERS,
                method="POST"
            )
            
            with urllib.request.urlopen(req, timeout=60) as response:
                result = json.loads(response.read().decode("utf-8"))
                
                if "error" in result:
                    print(f"  [X] 失败: {result['error'].get('message', '未知错误')}")
                else:
                    print(f"  [OK] 成功!")
                    content = result.get('choices', [{}])[0].get('message', {}).get('content', '')
                    print(f"  回复: {content[:150]}...")
                    break
                    
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8", errors="ignore")
            try:
                err = json.loads(error_body)
                print(f"  [X] HTTP {e.code}: {err.get('error', {}).get('message', error_body[:100])}")
            except:
                print(f"  [X] HTTP {e.code}: {error_body[:100]}")
        except Exception as e:
            print(f"  [X] 错误: {e}")
    print()

def test_streaming():
    """测试流式输出"""
    print("=" * 50)
    print("测试流式输出")
    print("=" * 50)
    
    payload = {
        "model": "claude-sonnet-4-6",
        "messages": [{"role": "user", "content": "你好"}],
        "stream": True
    }
    
    try:
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers=HEADERS,
            method="POST"
        )
        
        with urllib.request.urlopen(req, timeout=30) as response:
            content_type = response.headers.get('Content-Type', '')
            print(f"Content-Type: {content_type}")
            
            if 'text/event-stream' in content_type or 'stream' in content_type:
                print("[OK] 流式响应 (SSE)")
                print("前5行数据:")
                for i in range(5):
                    line = response.readline().decode('utf-8').strip()
                    if line:
                        print(f"  {line[:100]}")
            else:
                # 一次性读取
                data = response.read().decode('utf-8')
                print(f"非流式响应，长度: {len(data)}")
                print(f"内容预览: {data[:200]}...")
            print()
            
    except Exception as e:
        print(f"[X] 错误: {e}\n")

if __name__ == "__main__":
    test_chat()
    test_tool_calling()
    test_vision()
    test_streaming()
