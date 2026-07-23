#!/usr/bin/env bash
# stop hook: never emit followup_message (Cursor would auto-continue without user consent)
set -euo pipefail
cat >/dev/null || true
echo '{}'
exit 0