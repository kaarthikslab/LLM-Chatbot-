"""Measures cache-miss vs cache-hit latency for your chat service.

Usage:
    python measure.py                          # tests http://localhost:8000
    python measure.py https://your-app.onrender.com

Before running, restart the server with a higher rate limit so the test is not blocked:
    RATE_LIMIT=200/minute uvicorn main:app --host 0.0.0.0 --port 8000
"""
import json
import statistics
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")

PROMPTS = [
    "Explain how DNS resolution works in four sentences.",
    "What is the difference between a process and a thread?",
    "Write a Python function that reverses a linked list.",
    "Summarize the CAP theorem in simple words.",
    "Translate 'Where is the nearest hospital?' into Hindi and Tamil.",
    "What does HTTP status code 502 mean?",
    "Give three tips for writing clean SQL queries.",
    "Explain what a hash table is and when to use one.",
    "What is the difference between REST and GraphQL?",
    "Write a short email asking a colleague to review my pull request.",
]


def post(message: str):
    body = json.dumps({"message": message}).encode()
    req = urllib.request.Request(BASE + "/api/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            r.read()
            ms = (time.perf_counter() - start) * 1000
            return r.status, r.headers.get("X-Cache"), ms
    except urllib.error.HTTPError as e:
        return e.code, None, (time.perf_counter() - start) * 1000


def run_pass(label: str, prompts: list[str], expected: str):
    times = []
    for i, p in enumerate(prompts, 1):
        code, cache, ms = post(p)
        if code == 429:
            sys.exit("\nBlocked by the rate limit (429). Restart the server with "
                     "RATE_LIMIT=200/minute and run this again.")
        if code != 200:
            sys.exit(f"\nRequest failed with HTTP {code}. Check the server logs.")
        flag = "" if cache == expected else f"  (unexpected X-Cache: {cache})"
        print(f"  {label} {i:>2}: {ms:8.1f} ms  [{cache}]{flag}")
        if cache == expected:
            times.append(ms)
    return times


run_id = int(time.time())                       # makes every prompt new, so pass 1 is all misses
prompts = [f"{p} (test {run_id})" for p in PROMPTS]

print(f"Target: {BASE}\n\nPass 1 (cache misses, real model calls):")
misses = run_pass("miss", prompts, "MISS")
print("\nPass 2 (same prompts again, cache hits):")
hits = run_pass("hit ", prompts, "HIT")

if not misses or not hits:
    sys.exit("\nNot enough valid samples. Is the cache enabled on this server?")

mm, mh = statistics.median(misses), statistics.median(hits)
print("\n================ RESULTS ================")
print(f"Cache miss  median: {mm:8.1f} ms   (min {min(misses):.0f}, max {max(misses):.0f}, n={len(misses)})")
print(f"Cache hit   median: {mh:8.1f} ms   (min {min(hits):.0f}, max {max(hits):.0f}, n={len(hits)})")
print(f"Speedup on repeated prompts: about {mm / mh:.0f}x")
print("=========================================")
print('\nResume wording: "cutting repeat-prompt latency from '
      f'{mm:.0f} ms to {mh:.0f} ms (median of {len(misses)} prompts)"')
try:
    with urllib.request.urlopen(BASE + "/api/stats", timeout=10) as r:
        print("\nServer stats:", r.read().decode())
except Exception:
    pass
