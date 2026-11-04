#!/usr/bin/env bash
# 一键在线升级：fetch → 判断落后 → 快进合并 → 跑测试 → 重启服务
# 用法：
#   scripts/upgrade.sh --check   只看计划，不改动
#   scripts/upgrade.sh           执行升级
# 环境变量：REMOTE（默认 origin）、BRANCH（默认 main）、SERVICE（默认 cube-agent.service）、SKIP_TESTS=1
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-cube-agent.service}"
MODE="apply"
[ "${1:-}" = "--check" ] && MODE="check"

cd "$REPO_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FAIL: $REPO_DIR 不是 git 仓库" >&2
  exit 2
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "FAIL: 未配置远程 '$REMOTE'。先执行：" >&2
  echo "  git remote add origin git@github.com:ctomall/dsh-cube-agent.git" >&2
  echo "  git push -u origin $BRANCH" >&2
  exit 2
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "FAIL: 工作区有未提交改动，先 commit 或 stash（升级只做快进，不覆盖本地）" >&2
  git status --short >&2
  exit 3
fi

BEFORE="$(git rev-parse --short HEAD)"
echo "== 当前版本 $BEFORE（$BRANCH @ $REMOTE）"

if ! git fetch --prune "$REMOTE" "$BRANCH" 2>/dev/null; then
  echo "FAIL: 无法从 $REMOTE 拉取（远程仓库不存在或无权限）" >&2
  echo "  远程地址：$(git remote get-url "$REMOTE" 2>/dev/null || echo 未配置)" >&2
  exit 4
fi
BEHIND="$(git rev-list --count "HEAD..$REMOTE/$BRANCH")"
echo "== 落后 $BEHIND 个提交"

if [ "$BEHIND" -eq 0 ]; then
  echo "OK: 已是最新，无需升级"
  exit 0
fi

echo "== 待升级内容："
git log --oneline "HEAD..$REMOTE/$BRANCH" | head -10

if [ "$MODE" = "check" ]; then
  echo "== --check 模式：未做任何改动"
  exit 0
fi

git pull --ff-only "$REMOTE" "$BRANCH"

if [ "${SKIP_TESTS:-0}" != "1" ]; then
  echo "== 跑测试"
  if ! node --test impl/test/*.test.mjs; then
    echo "FAIL: 新版本测试未通过 —— 回滚到 $BEFORE（不重启、不留坏版本）"
    git reset --hard "$BEFORE"
    exit 5
  fi
fi

AFTER="$(git rev-parse --short HEAD)"
echo "== 升级完成 $BEFORE -> $AFTER"

if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}"; then
  echo "== 重启 ${SERVICE}"
  systemctl restart "$SERVICE"
  # 等就绪再判定，避免把"正在重启"记成"服务挂了"
  ready=0
  for i in $(seq 1 40); do
    if curl -s -o /dev/null -m 3 "http://127.0.0.1:${PORT:-8787}/healthz"; then ready=$i; break; fi
    sleep 1
  done
  if [ "$ready" -eq 0 ]; then
    echo "FAIL: 重启后 40s 内 /healthz 未就绪 —— 回滚到 $BEFORE"
    git reset --hard "$BEFORE"
    systemctl restart "$SERVICE"
    exit 6
  fi
  echo "== 就绪（${ready}s）"
  systemctl is-active "$SERVICE"
else
  echo "WARN: 未安装 ${SERVICE}，服务未重启（手动：node impl/src/server.mjs）"
fi
