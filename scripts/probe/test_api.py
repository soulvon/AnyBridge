#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""测试 muyuan.do API 的图片理解能力"""

import base64
import json
import urllib.request
import urllib.error

API_KEY = "sk-yQDLULvK2SF4FfXrgHGtiKXFD3gdySJD1fDchhQV1CRqMyPE"
API_URL = "https://muyuan.do/v1/chat/completions"
IMAGE_PATH = r"C:\Users\admin\Desktop\PixPin_20260604090853.png"

def encode_image(image_path):
    """将图片转为 base64"""
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

def test_vision():
    """测试图片理解能力"""
    print("=" * 50)
    print("测试图片理解能力")
    print("=" * 50)
    
    # 读取并编码图片
    print(f"正在读取图片: {IMAGE_PATH}")
    try:
        image_base64 = encode_image(IMAGE_PATH)
        print(f"图片编码完成，大小: {len(image_base64)} 字符")
    except Exception as e:
        print(f"读取图片失败: {e}")
        return
    
    # 构建请求
    payload = {
        "model": "claude-sonnet-4-6",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "描述这张图片"},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{image_base64}"
                        }
                    }
                ]
            }
        ]
    }
    
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    
    # 发送请求
    print("\n正在发送请求...")
    try:
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST"
        )
        
        with urllib.request.urlopen(req, timeout=120) as response:
            result = json.loads(response.read().decode("utf-8"))
            
            print("\n" + "=" * 50)
            print("API 响应结果")
            print("=" * 50)
            
            if "error" in result:
                print(f"[X] 请求失败")
                print(f"错误信息: {result['error'].get('message', '未知错误')}")
                return
            
            # 解析成功响应
            print(f"[OK] 请求成功")
            print(f"模型: {result.get('model', 'N/A')}")
            print(f"完成原因: {result.get('choices', [{}])[0].get('finish_reason', 'N/A')}")
            print("\n模型回复内容:")
            print("-" * 50)
            content = result.get('choices', [{}])[0].get('message', {}).get('content', '')
            print(content if content else "(空内容)")
            print("-" * 50)
            
            # Token 使用情况
            usage = result.get('usage', {})
            print(f"\nToken 使用情况:")
            print(f"  Prompt tokens: {usage.get('prompt_tokens', 'N/A')}")
            print(f"  Completion tokens: {usage.get('completion_tokens', 'N/A')}")
            print(f"  Total tokens: {usage.get('total_tokens', 'N/A')}")
            
    except urllib.error.HTTPError as e:
        print(f"[X] HTTP 错误: {e.code}")
        try:
            error_body = json.loads(e.read().decode("utf-8"))
            print(f"错误详情: {error_body}")
        except:
            print(f"错误详情: {e.read().decode('utf-8')}")
    except Exception as e:
        print(f"[X] 请求异常: {e}")

if __name__ == "__main__":
    test_vision()
