#!/usr/bin/env bash
# 持久化演练：造一条数据 → 重启服务 → 读回来。会重启 cube-agent.service。
set -uo pipefail
BASE="${1:-https://cto.ila3.top}"
PW=$(cut -d= -f2- .runtime-app-password); T_A=$(cut -d= -f2- .runtime-tokens | head -1)
JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT

for i in $(seq 1 30); do curl -s -o /dev/null -m 3 "$BASE/healthz" && break; sleep 1; done
c=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -m 15 -X POST -d "password=$PW" "$BASE/login")
if [ "$c" = "429" ]; then echo "登录被限流（上一轮爆破测试占用配额），等 50s"; sleep 50
  curl -s -o /dev/null -c "$JAR" -m 15 -X POST -d "password=$PW" "$BASE/login"; fi

title="持久化演练-$(date +%s)"
sid=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -H 'content-type: application/json' -m 15 \
  -d "{\"title\":\"$title\"}" "$BASE/api/sessions" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$sid" ] || { echo "FAIL: 建会话失败"; exit 2; }
echo "新建会话：$sid（$title）"

sudo systemctl restart cube-agent.service
for i in $(seq 1 40); do sleep 1; [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$BASE/healthz")" = "200" ] && break; done

got=$(curl -s -b "$JAR" -H "Authorization: Bearer $T_A" -m 15 "$BASE/api/sessions/$sid" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("session",{}).get("title",""))' 2>/dev/null)
if [ "$got" = "$title" ]; then echo "PASS: 重启后会话仍在（$got）"; exit 0; else echo "FAIL: 重启后读回 '$got'，期望 '$title'"; exit 1; fi
