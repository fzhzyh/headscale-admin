#!/usr/bin/env python3
"""诊断：同一 shell 下 curl 成功而 Python urllib 返回 401 的原因。

排查方向：
  1. 代理环境变量（urllib 会自动读 http_proxy/https_proxy，curl 有自己的 no_proxy 规则）
  2. 请求头差异
  3. Key 值本身（长度/空白字符）
"""
import os
import subprocess
import urllib.request
import urllib.error

URL = "http://127.0.0.1:18080/api/v1/node"
K = os.environ.get("HS_API_KEY", "")

print("=== 0. 环境 ===")
print(f"  HS_API_KEY 长度: {len(K)}  首 22 位: {K[:22]}")
for v in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy",
          "ALL_PROXY", "no_proxy", "NO_PROXY"):
    if os.environ.get(v):
        print(f"  ⚠️ {v} = {os.environ[v]}")

# urllib 实际使用的代理（None 表示不走代理）
print(f"  urllib 解析到的代理: {urllib.request.getproxies() or '无'}")

print("\n=== 1. urllib 直连（带 Content-Type）===")
req = urllib.request.Request(
    URL,
    headers={"Authorization": f"Bearer {K}", "Content-Type": "application/json", "Accept": "application/json"},
)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print(f"  HTTP {r.status}  {r.read()[:80]}")
except urllib.error.HTTPError as e:
    print(f"  HTTP {e.code}  {e.read()[:120]}  headers={dict(e.headers)}")

print("\n=== 2. urllib 直连（不带 Content-Type）===")
req2 = urllib.request.Request(URL, headers={"Authorization": f"Bearer {K}"})
try:
    with urllib.request.urlopen(req2, timeout=10) as r:
        print(f"  HTTP {r.status}  {r.read()[:80]}")
except urllib.error.HTTPError as e:
    print(f"  HTTP {e.code}  {e.read()[:120]}")

print("\n=== 3. urllib 显式禁代理 ===")
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
req3 = urllib.request.Request(URL, headers={"Authorization": f"Bearer {K}"})
try:
    with opener.open(req3, timeout=10) as r:
        print(f"  HTTP {r.status}  {r.read()[:80]}")
except urllib.error.HTTPError as e:
    print(f"  HTTP {e.code}  {e.read()[:120]}")

print("\n=== 4. curl 对照组（同 shell 同 Key）===")
out = subprocess.run(
    ["curl", "-sS", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}", "-H", f"Authorization: Bearer {K}", URL],
    capture_output=True, text=True,
)
print(f"  curl → HTTP {out.stdout.strip()}  {out.stderr.strip()[:80]}")
