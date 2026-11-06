# 共享：登录并容忍 429（验收器跑过登录爆破后，登录桶可能还在窗口内）
# 用法：login_cookie <base> <jar> <password> [max_attempts] [sleep_s]
login_cookie() {
  local base="$1" jar="$2" pw="$3" max="${4:-4}" nap="${5:-20}" code="" i
  for i in $(seq 1 "$max"); do
    code=$(curl -s -o /dev/null -c "$jar" -w '%{http_code}' -m 20 -X POST -d "password=$pw" "$base/login")
    [ "$code" != "429" ] && { printf '%s' "$code"; return 0; }
    [ "$i" -lt "$max" ] && sleep "$nap"
  done
  printf '%s' "$code"
  return 1
}
