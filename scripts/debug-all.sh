#!/usr/bin/env bash
# LinkedReach — full debug terminal
# Shows: all workers, Playwright, proxy assignments, BullMQ queues, keep-alive
# Usage: bash scripts/debug-all.sh

set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$REPO/backend"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YEL='\033[1;33m'; GRN='\033[0;32m'
CYN='\033[0;36m'; MAG='\033[0;35m'; BLU='\033[0;34m'
WHT='\033[1;37m'; DIM='\033[2m'; RST='\033[0m'

ts() { date '+%H:%M:%S'; }

banner() {
  echo ""
  echo -e "${WHT}══════════════════════════════════════════════════════════════════${RST}"
  echo -e "${WHT}  LinkedReach Debug Monitor — $(date '+%Y-%m-%d %H:%M:%S')${RST}"
  echo -e "${WHT}══════════════════════════════════════════════════════════════════${RST}"
  echo ""
}

# ── Kill existing backend on 3001 ─────────────────────────────────────────────
echo -e "${YEL}[$(ts())] Clearing port 3001...${RST}"
lsof -ti:3001 | xargs kill -9 2>/dev/null || true
sleep 1

banner

# ── Start backend with full debug env ─────────────────────────────────────────
echo -e "${GRN}[$(ts())] Starting backend with full debug logging...${RST}"

cd "$BACKEND"

# Pipe through a colorizer so different log categories get different colors
DEBUG_PLAYWRIGHT=1 \
DEBUG_PROXY=1 \
NODE_OPTIONS="--max-old-space-size=512" \
  npx tsx watch --env-file=.env src/index.ts 2>&1 | awk '
{
  line = $0

  # Timestamps / markers
  if (line ~ /\[LOGIN DEBUG\]/)         { print "\033[0;36m" line "\033[0m"; next }
  if (line ~ /\[login\]/)               { print "\033[0;36m" line "\033[0m"; next }
  if (line ~ /\[browserPool\]/)         { print "\033[0;35m" line "\033[0m"; next }
  if (line ~ /\[keepAlive\]/)           { print "\033[0;34m" line "\033[0m"; next }
  if (line ~ /\[seqRunner\]/)           { print "\033[0;32m" line "\033[0m"; next }
  if (line ~ /\[sequenceRunner\]/)      { print "\033[0;32m" line "\033[0m"; next }
  if (line ~ /\[scheduler\]/)           { print "\033[1;33m" line "\033[0m"; next }
  if (line ~ /\[qualify\]/)             { print "\033[0;33m" line "\033[0m"; next }
  if (line ~ /\[inbox\]/)               { print "\033[0;34m" line "\033[0m"; next }
  if (line ~ /\[salesNav\]/)            { print "\033[0;35m" line "\033[0m"; next }
  if (line ~ /\[ExtHub\]/)              { print "\033[2;37m" line "\033[0m"; next }
  if (line ~ /proxy|PROXY|Proxy/)       { print "\033[1;35m" line "\033[0m"; next }
  if (line ~ /ERROR|error|Error/)       { print "\033[0;31m" line "\033[0m"; next }
  if (line ~ /WARN|warn|Warning/)       { print "\033[1;33m" line "\033[0m"; next }
  if (line ~ /success|Success|✓|done/)  { print "\033[0;32m" line "\033[0m"; next }
  if (line ~ /challenge|push|notif/)    { print "\033[1;36m" line "\033[0m"; next }
  if (line ~ /li_at|cookie|Cookie/)     { print "\033[1;32m" line "\033[0m"; next }
  if (line ~ /Playwright|chromium|CDP/) { print "\033[0;33m" line "\033[0m"; next }
  if (line ~ /queue|Queue|bull|Bull/)   { print "\033[2;37m" line "\033[0m"; next }

  print line
}
'
