#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""简化测试 muyuan.do API"""

import json
import urllib.request
import urllib.error

API_KEY = "sk-yQDLULvK2SF4FfXrgHGtiKXFD3gdySJD1fDchhQV1CRqMyPE"
API_URL = "https://muyuan.do/v1/chat/completions"

def test_models():
    """获取模型列表"""
    print("=" * 50)
    print("1. 获取模型列表")
    print("=" * 50)
    
    headers = {
        "Authorization": f"Bearer {API_KEY}"
    }
    
    try:
        req = urllib.request.Request(
            "https://muyuan.do/v1/models",
            headers=headers,
            method="GET"
        )
        
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
            
            print(f"[OK] 获取成功，共 {len(result.get('data', []))} 个模型")
            print("\n支持视觉的模型(Claude系列):")
            for model in result.get('data', []):
                model_id = model.get('id', '')
                if 'claude' in model_id.lower():
                    print(f"  - {model_id}")
            print()
            
    except Exception as e:
        print(f"[X] 错误: {e}")

def test_tool_calling():
    """测试工具调用"""
    print("=" * 50)
    print("2. 测试工具调用")
    print("=" * 50)
    
    payload = {
        "model": "claude-sonnet-4-6",
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
    
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0"
    }
    
    try:
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST"
        )
        
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
            
            if "error" in result:
                print(f"[X] 请求失败: {result['error'].get('message', '未知错误')}")
                return
            
            print("[OK] 工具调用成功")
            message = result.get('choices', [{}])[0].get('message', {})
            tool_calls = message.get('tool_calls', [])
            
            if tool_calls:
                print(f"  检测到 {len(tool_calls)} 个工具调用")
                for tc in tool_calls:
                    print(f"    函数: {tc.get('function', {}).get('name', 'N/A')}")
                    print(f"    参数: {tc.get('function', {}).get('arguments', 'N/A')}")
            else:
                print("  未检测到工具调用")
            print()
            
    except Exception as e:
        print(f"[X] 错误: {e}")

def test_vision_with_url():
    """测试图片理解 - 使用在线图片URL"""
    print("=" * 50)
    print("3. 测试图片理解 (使用在线图片URL)")
    print("=" * 50)
    
    # 使用一个稳定的测试图片
    image_url = "https://picsum.photos/400/300"
    
    payload = {
        "model": "claude-sonnet-4-6",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "简要描述这张图片"},
                    {"type": "image_url", "image_url": {"url": image_url}}
                ]
            }
        ],
        "max_tokens": 500
    }
    
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    
    try:
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST"
        )
        
        with urllib.request.urlopen(req, timeout=60) as response:
            result = json.loads(response.read().decode("utf-8"))
            
            if "error" in result:
                print(f"[X] 请求失败: {result['error'].get('message', '未知错误')}")
                return
            
            print("[OK] 图片理解成功")
            content = result.get('choices', [{}])[0].get('message', {}).get('content', '')
            print(f"  回复: {content[:200]}...")
            print()
            
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="ignore")
        print(f"[X] HTTP {e.code} 错误")
        try:
            err = json.loads(error_body)
            print(f"    详情: {err.get('error', {}).get('message', error_body)}")
        except:
            print(f"    详情: {error_body[:200]}")
    except Exception as e:
        print(f"[X] 错误: {e}")

def test_streaming():
    """测试流式输出"""
    print("=" * 50)
    print("4. 测试流式输出")
    print("=" * 50)
    
    payload = {
        "model": "claude-sonnet-4-6",
        "messages": [{"role": "user", "content": "你好"}],
        "stream": True
    }
    
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    
    try:
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST"
        )
        
        with urllib.request.urlopen(req, timeout=30) as response:
            content_type = response.headers.get('Content-Type', '')
            
            if 'text/event-stream' in content_type:
                print("[OK] 支持流式输出 (SSE)")
                # 读取前几行
                lines = []
                for i, line in enumerate(response):
                    if i >= 5:
                        break
                    line = line.decode('utf-8').strip()
                    if line:
                        lines.append(line)
                print(f"  前 {len(lines)} 行响应预览:")
                for line in lines:
                    print(f"    {line[:80]}...")
            else:
                print("[INFO] 非流式响应")
                result = json.loads(response.read().decode("utf-8"))
                content = result.get('choices', [{}])[0].get('message', {}).get('content', '')
                print(f"  回复: {content[:100]}...")
            print()
            
    except Exception as e:
        print(f"[X] 错误: {e}")

if __name__ == "__main__":
    print("\n" + "=" * 50)
    print(" muyuan.do API 功能测试")
    print("=" * 50 + "\n")
    
    test_models()
    test_tool_calling()
    test_vision_with_url()
    test_streaming()
    
    print("=" * 50)
    print("测试完成")
    print("=" * 50)
