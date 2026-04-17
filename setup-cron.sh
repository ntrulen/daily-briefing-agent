#!/bin/bash
# setup-cron.sh — Install a cron job to run daily-briefing.js at 7:00 AM every day
#
# Usage:
#   chmod +x setup-cron.sh
#   ./setup-cron.sh
#
# To remove the cron job later:
#   crontab -e   →  delete the line containing "daily-briefing.js"

set -euo pipefail

# ── Resolve paths ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/daily-briefing.js"
LOG_FILE="$HOME/Desktop/daily-briefing-agent/briefing.log"

# Detect the node binary (support nvm, homebrew, system installs)
NODE_BIN="$(command -v node 2>/dev/null || echo '/usr/local/bin/node')"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "✗ Could not find the 'node' binary at $NODE_BIN."
  echo "  Please install Node.js and try again."
  exit 1
fi

if [[ ! -f "$SCRIPT_PATH" ]]; then
  echo "✗ Script not found at $SCRIPT_PATH"
  exit 1
fi

# ── Build the cron entry ───────────────────────────────────────────────────────

# Format: min  hour  dayOfMonth  month  dayOfWeek  command
# 0 7 * * *  →  every day at 07:00
CRON_ENTRY="0 7 * * * $NODE_BIN $SCRIPT_PATH >> $LOG_FILE 2>&1"

# ── Install (idempotent) ───────────────────────────────────────────────────────

# Read existing crontab (suppress error if there isn't one yet)
EXISTING="$(crontab -l 2>/dev/null || true)"

if echo "$EXISTING" | grep -qF "daily-briefing.js"; then
  echo "✓ Cron job already installed — nothing to do."
  echo ""
  echo "  Current entry:"
  echo "  $(echo "$EXISTING" | grep "daily-briefing.js")"
else
  # Append the new entry and write back
  { echo "$EXISTING"; echo "$CRON_ENTRY"; } | crontab -
  echo "✓ Cron job installed successfully!"
  echo ""
  echo "  Schedule : every day at 7:00 AM"
  echo "  Command  : $NODE_BIN $SCRIPT_PATH"
  echo "  Log file : $LOG_FILE"
fi

# ── Ensure the log file directory exists ──────────────────────────────────────

LOG_DIR="$(dirname "$LOG_FILE")"
mkdir -p "$LOG_DIR"
touch "$LOG_FILE"

echo ""
echo "To view logs in real time:"
echo "  tail -f $LOG_FILE"
echo ""
echo "To remove the cron job:"
echo "  crontab -e    (then delete the line containing daily-briefing.js)"
