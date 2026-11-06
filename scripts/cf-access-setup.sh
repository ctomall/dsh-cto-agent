#!/usr/bin/env bash
# 为 cto.ila3.top 配置 Cloudflare Access + 速率限制。
# 需要：CLOUDFLARE_API_TOKEN（Access:App 读写 + Zone:RateLimit 编辑）、CF_ACCOUNT_ID、CF_ZONE_ID
# 用法：scripts/cf-access-setup.sh --dry-run   # 只打印将要发送的请求
#       scripts/cf-access-setup.sh             # 真正创建
set -euo pipefail

HOST="${HOST:-cto.ila3.top}"
APP_NAME="${APP_NAME:-cube-agent}"
ALLOW_EMAILS="${ALLOW_EMAILS:-}"          # 逗号分隔；空则用 "一次性 PIN 到指定邮箱" 都会失败，必须给
MODE="apply"; [ "${1:-}" = "--dry-run" ] && MODE="dry-run"

need() { [ -n "${!1:-}" ] || { echo "FAIL: 缺少环境变量 $1" >&2; exit 2; }; }

if [ "$MODE" = "apply" ]; then
  need CLOUDFLARE_API_TOKEN; need CF_ACCOUNT_ID; need CF_ZONE_ID; need ALLOW_EMAILS
else
  : "${CLOUDFLARE_API_TOKEN:=<dry-run>}" "${CF_ACCOUNT_ID:=<dry-run>}" "${CF_ZONE_ID:=<dry-run>}" "${ALLOW_EMAILS:=someone@example.com}"
fi

API="https://api.cloudflare.com/client/v4"

# 1) Access 应用（self-hosted，覆盖整个域名）
APP_PAYLOAD=$(cat <<JSON
{
  "name": "${APP_NAME}",
  "domain": "${HOST}",
  "type": "self_hosted",
  "session_duration": "24h",
  "app_launcher_visible": false,
  "auto_redirect_to_identity": true
}
JSON
)

# 2) 允许邮箱策略
POLICY_PAYLOAD=$(python3 - "$ALLOW_EMAILS" <<'PY'
import json, sys
emails = [e.strip() for e in sys.argv[1].split(',') if e.strip()]
print(json.dumps({
  "name": "allow-listed-emails",
  "decision": "allow",
  "include": [{"email": {"email": e}} for e in emails],
}, ensure_ascii=False))
PY
)

# 3) 边缘速率限制（应用层也有一份，双保险）
# 注意：规则集入口（rulesets entrypoint）的 PUT 体必须是 {"rules":[...]}，
# 直接把规则平铺在顶层会被 CF 拒绝（这是接入前最容易踩的一脚）。
RATELIMIT_PAYLOAD=$(cat <<JSON
{
  "rules": [
    {
      "description": "cube-agent edge rate limit",
      "expression": "(http.host eq \"${HOST}\" and starts_with(http.request.uri.path, \"/api/\"))",
      "action": "block",
      "ratelimit": { "characteristics": ["ip.src"], "period": 60, "requests_per_period": 120, "mitigation_timeout": 60 }
    }
  ]
}
JSON
)

echo "== 目标：$HOST（模式：$MODE）"
echo "--- 1) POST $API/accounts/\$CF_ACCOUNT_ID/access/apps"
echo "$APP_PAYLOAD"
echo "--- 2) POST $API/accounts/\$CF_ACCOUNT_ID/access/apps/<app_id>/policies"
echo "$POLICY_PAYLOAD"
echo "--- 3) PUT $API/zones/\$CF_ZONE_ID/rulesets/phases/http_ratelimit/entrypoint"
echo "$RATELIMIT_PAYLOAD"

if [ "$MODE" = "dry-run" ]; then
  # 结构自检：没有 token 也能验证"要发的三份 JSON 形状对不对"
  python3 - "$APP_PAYLOAD" "$POLICY_PAYLOAD" "$RATELIMIT_PAYLOAD" "$HOST" <<'PY'
import json, sys
app, pol, rl, host = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
a, p, r = json.loads(app), json.loads(pol), json.loads(rl)
assert a["type"] == "self_hosted" and a["domain"] == host, "Access 应用必须 self_hosted 且 domain 正确"
assert p["decision"] == "allow" and p["include"], "策略必须 allow 且有 include 条件"
assert isinstance(r.get("rules"), list) and r["rules"], "限流必须是 rulesets 形状（rules 数组）"
rule = r["rules"][0]
assert rule["action"] == "block" and "ratelimit" in rule, "限流规则缺少 action/ratelimit"
assert rule["ratelimit"]["period"] >= 10, "限流周期不合理"
print("== 结构自检通过：access app / policy / ratelimit 三份 payload 形状正确")
PY
  echo "== dry-run：未发送任何请求"
  exit 0
fi

hdr=(-H "authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json')

app=$(curl -sS -X POST "$API/accounts/$CF_ACCOUNT_ID/access/apps" "${hdr[@]}" -d "$APP_PAYLOAD")
app_id=$(printf '%s' "$app" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["result"]["id"] if d.get("success") else "")')
[ -n "$app_id" ] || { echo "FAIL: 创建 Access 应用失败：$app" >&2; exit 3; }
echo "== Access 应用已创建：$app_id"

curl -sS -X POST "$API/accounts/$CF_ACCOUNT_ID/access/apps/$app_id/policies" "${hdr[@]}" -d "$POLICY_PAYLOAD" >/dev/null
echo "== 策略已创建（允许 ${ALLOW_EMAILS}）"

curl -sS -X PUT "$API/zones/$CF_ZONE_ID/rulesets/phases/http_ratelimit/entrypoint" "${hdr[@]}" -d "$RATELIMIT_PAYLOAD" >/dev/null
echo "== 边缘速率限制已配置"
echo "== 完成：访问 https://$HOST 应被 Access 拦截"
