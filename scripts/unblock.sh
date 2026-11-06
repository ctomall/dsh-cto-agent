#!/usr/bin/env bash
# 解除阻塞：把"缺凭据"这件事压缩成一条命令。
#   scripts/unblock.sh --check                         只看缺什么
#   scripts/unblock.sh --model-key sk-xxx              接入真实模型（可选 --base-url/--model/--probe）
#   scripts/unblock.sh --cf-token t --cf-account a --cf-zone z --allow-emails me@x.com
# 密钥只落地到 /etc/cube-agent/（0600），不进仓库、不回显。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_FILE=/etc/cube-agent/env
KEY_FILE=/etc/cube-agent/model.key
BASE_URL=""; MODEL=""; PROBE=0; CHECK=0; VERIFY=0
MODEL_KEY=""; CF_TOKEN=""; CF_ACCOUNT=""; CF_ZONE=""; EMAILS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --model-key) MODEL_KEY="$2"; shift ;;
    --base-url) BASE_URL="$2"; shift ;;
    --model) MODEL="$2"; shift ;;
    --probe) PROBE=1 ;;
    --verify) VERIFY=1 ;;
    --cf-token) CF_TOKEN="$2"; shift ;;
    --cf-account) CF_ACCOUNT="$2"; shift ;;
    --cf-zone) CF_ZONE="$2"; shift ;;
    --allow-emails) EMAILS="$2"; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

have_model() { sudo cut -d= -f1 "$ENV_FILE" 2>/dev/null | grep -q '^MODEL_BASE_URL$' || [ -f "$KEY_FILE" ]; }
have_cf() { [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || [ -f /etc/cube-agent/cf.env ]; }

status() {
  echo "== 阻塞项现状"
  if have_model; then echo "  ① 模型凭据：已配置"; else echo "  ① 模型凭据：缺失（需要 MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY(_FILE)）"; fi
  if have_cf; then echo "  ③ Cloudflare：已配置"; else echo "  ③ Cloudflare：缺失（需要 CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID / CF_ZONE_ID）"; fi
  echo
  echo "== 复验命令（--check 不跑，避免占用登录限流）"
  echo "   ./scripts/acceptance.sh http://127.0.0.1:8787"
  echo "   接入 key 后想一次跑通端到端：scripts/unblock.sh --model-key <k> --verify"
}

if [ "$CHECK" = 1 ] || { [ -z "$MODEL_KEY" ] && [ -z "$CF_TOKEN" ]; }; then
  status
  [ "$CHECK" = 1 ] && exit 0
  echo
  echo "用法："
  echo "  scripts/unblock.sh --model-key sk-xxx [--base-url https://api.deepseek.com/v1] [--model deepseek-chat] [--probe]"
  echo "  scripts/unblock.sh --cf-token t --cf-account a --cf-zone z --allow-emails me@x.com"
  exit 2
fi

if [ -n "$MODEL_KEY" ]; then
  case "$MODEL_KEY" in
    sk-*) : ;;
    *) echo "FAIL: 模型 key 通常以 sk- 开头，请确认" >&2; exit 2 ;;
  esac
  sudo install -d -m 750 /etc/cube-agent
  printf '%s\n' "$MODEL_KEY" | sudo tee "$KEY_FILE" >/dev/null
  sudo chmod 600 "$KEY_FILE"
  BASE_URL="${BASE_URL:-https://api.deepseek.com/v1}"
  MODEL="${MODEL:-deepseek-chat}"
  sudo sed -i '/^MODEL_/d' "$ENV_FILE" 2>/dev/null || true
  printf 'MODEL_BASE_URL=%s\nMODEL_NAME=%s\nMODEL_API_KEY_FILE=%s\n' "$BASE_URL" "$MODEL" "$KEY_FILE" | sudo tee -a "$ENV_FILE" >/dev/null
  echo "== 已写入 $KEY_FILE（0600）与 $ENV_FILE"
  sudo systemctl restart cube-agent.service
  for i in $(seq 1 30); do sleep 1; curl -s -o /dev/null -m 3 http://127.0.0.1:8787/healthz && break; done
  echo "== model/status:"; node scripts/model-doctor.mjs || true
  if [ "$PROBE" = 1 ]; then echo "== 真实探测（会消耗一次调用）"; node scripts/model-doctor.mjs --probe || exit 3; fi
  if [ "$VERIFY" = 1 ]; then
    echo "== 端到端：目标 → 模型选工具 → 审批 → 产出"
    scripts/first-real-run.sh http://127.0.0.1:8787 || { echo "FAIL: 端到端未通过（看上面哪一步红的）" >&2; exit 5; }
  fi
fi

if [ -n "$CF_TOKEN" ]; then
  echo "== 校验 Cloudflare token"
  v=$(curl -s -m 15 -H "authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify)
  echo "$v" | grep -q '"status":"active"' || { echo "FAIL: token 校验未通过：$(echo "$v" | head -c 200)" >&2; exit 4; }
  echo "== token 有效，开始创建 Access 应用与边缘限流"
  CLOUDFLARE_API_TOKEN="$CF_TOKEN" CF_ACCOUNT_ID="$CF_ACCOUNT" CF_ZONE_ID="$CF_ZONE" ALLOW_EMAILS="$EMAILS" scripts/cf-access-setup.sh
  sudo install -d -m 750 /etc/cube-agent
  printf 'CLOUDFLARE_API_TOKEN=%s\nCF_ACCOUNT_ID=%s\nCF_ZONE_ID=%s\n' "$CF_TOKEN" "$CF_ACCOUNT" "$CF_ZONE" | sudo tee /etc/cube-agent/cf.env >/dev/null
  sudo chmod 600 /etc/cube-agent/cf.env
fi

echo
echo "== 解除后复验"
./scripts/acceptance.sh --require-all http://127.0.0.1:8787
