#!/usr/bin/env bash
# 密钥外泄扫描：口令/令牌会不会出现在「日志」或「数据库行」里。
# 与 secret-scan.sh 互补——那个查"有没有进 git"，这个查"有没有进运行面"。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
DB="${DB_PATH:-/var/lib/cube-agent/cube.db}"
ENV_FILE="${ENV_FILE:-/etc/cube-agent/env}"
pass=0; fail=0
ok(){ printf '  ✔ %-26s %s\n' "$1" "$2"; pass=$((pass+1)); }
no(){ printf '  ✖ %-26s %s\n' "$1" "$2"; fail=$((fail+1)); }

secrets=()
add(){ [ -n "${1:-}" ] && [ ${#1} -ge 8 ] && secrets+=("$1"); }
if [ -f .runtime-app-password ]; then add "$(grep -oP '(?<=APP_PASSWORD=).*' .runtime-app-password || true)"; fi
if sudo test -r "$ENV_FILE"; then
  add "$(sudo grep -oP '(?<=^CUBE_UPGRADE_TOKEN=).*' "$ENV_FILE" || true)"
  # CUBE_TOKENS 是 JSON：把每个 value 抽出来
  while read -r t; do add "$t"; done < <(sudo grep -oP '(?<=^CUBE_TOKENS=).*' "$ENV_FILE" | grep -oP '(?<=")[A-Za-z0-9_-]{8,}(?=")' || true)
  while read -r t; do add "$t"; done < <(sudo grep -oP '(?<=^MODEL_API_KEY=).*' "$ENV_FILE" || true)
fi
[ ${#secrets[@]} -gt 0 ] && ok "收集密钥" "${#secrets[@]} 个" || { ok "收集密钥" "0 个（环境可能未配置）"; }

echo "== 1) 运行日志（最近 7 天）"
log=$(sudo journalctl -u cube-agent.service --since '-7d' --no-pager 2>/dev/null || true)
hit=0
for s in "${secrets[@]:-}"; do
  [ -n "$s" ] || continue
  n=$(printf '%s' "$log" | grep -cF "$s" || true)
  [ "${n:-0}" -gt 0 ] && { hit=$((hit+n)); }
done
[ "$hit" -eq 0 ] && ok "日志无密钥" "0 次命中" || no "日志无密钥" "$hit 次命中"

echo "== 2) 数据库行"
if [ -f "$DB" ]; then
  res=$(node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(process.argv[1],{readOnly:true});
const secrets=process.argv.slice(2);
const targets=[['events','payload_json'],['audit_log','detail_json'],['messages','content'],['runs','input'],['sessions','title']];
let hits=0;
for (const [t,c] of targets) {
  for (const s of secrets) {
    try { hits += d.prepare(\`select count(*) n from \${t} where \${c} like '%' || ? || '%'\`).get(s).n } catch {}
  }
}
console.log(hits);
" "$DB" "${secrets[@]:-}" 2>&1)
  [ "${res:-1}" = 0 ] && ok "数据库无密钥" "0 行命中" || no "数据库无密钥" "$res 行命中"
else
  ok "数据库无密钥" "库不存在，跳过"
fi

echo "== 汇总：pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
