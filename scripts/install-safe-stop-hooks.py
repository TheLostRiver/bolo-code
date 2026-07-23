"""Install stop hooks that never emit followup_message."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOKS = ROOT / ".cursor" / "hooks"

STOP_PS1 = """# planning-with-files: stop
# Cursor stop hook: followup_message auto-continues the agent without user consent.
# Always return empty JSON — no forced continue.
$ErrorActionPreference = 'SilentlyContinue'
try { [void][Console]::In.ReadToEnd() } catch {}
Write-Output '{}'
exit 0
"""

STOP_SH = """#!/usr/bin/env bash
# stop: never emit followup_message (no auto-continue without user consent)
set -euo pipefail
cat >/dev/null || true
echo '{}'
exit 0
"""

def main() -> None:
    HOOKS.mkdir(parents=True, exist_ok=True)
    (HOOKS / "stop.ps1").write_text(STOP_PS1, encoding="utf-8", newline="\n")
    (HOOKS / "stop.sh").write_text(STOP_SH, encoding="utf-8", newline="\n")
    print("wrote", HOOKS / "stop.ps1")
    print("wrote", HOOKS / "stop.sh")

if __name__ == "__main__":
    main()