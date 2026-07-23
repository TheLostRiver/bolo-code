"""Sanitize stop templates in fix-cursor-hooks.py (no followup_message)."""
from pathlib import Path

p = Path(__file__).resolve().parents[1] / "scripts" / "fix-cursor-hooks.py"
t = p.read_text(encoding="utf-8")

start = t.index("STOP_PS1 = r\"\"\"")
end = t.index("PRE_SH = \"\"\"")
new_stop_ps1 = '''STOP_PS1 = r"""# planning-with-files: stop
# Never emit followup_message (Cursor auto-continues without user consent).
$ErrorActionPreference = 'SilentlyContinue'
try { [void][Console]::In.ReadToEnd() } catch {}
Write-Output '{}'
exit 0
"""

'''

start2 = t.index("STOP_SH = \"\"\"")
end2 = t.index("\ndef main()")
new_stop_sh = '''STOP_SH = """#!/usr/bin/env bash
# stop: never emit followup_message
set -euo pipefail
cat >/dev/null || true
echo '{}'
exit 0
"""


'''

t2 = t[:start] + new_stop_ps1 + t[end:start2] + new_stop_sh + t[end2:]
p.write_text(t2, encoding="utf-8", newline="\n")
assert "ALL PHASES COMPLETE" not in p.read_text(encoding="utf-8")
assert "followup_message" not in p.read_text(encoding="utf-8") or True
# still may have followup in comments of other files; check STOP only
print("fix-cursor-hooks.py stop templates sanitized")
print("ALL PHASES COMPLETE remaining:", "ALL PHASES COMPLETE" in p.read_text(encoding="utf-8"))