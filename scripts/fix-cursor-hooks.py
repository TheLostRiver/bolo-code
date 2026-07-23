"""Fix project .cursor/hooks for current Cursor schema."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / ".cursor"
HOOKS = ROOT / "hooks"


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")
    print(f"wrote {path}")


HOOKS_JSON = """{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      {
        "command": "powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/hooks/before-submit-prompt.ps1",
        "timeout": 10
      }
    ],
    "preToolUse": [
      {
        "command": "powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/hooks/pre-tool-use.ps1",
        "matcher": "Shell|Read|Write|Grep|Delete|Task",
        "timeout": 10
      }
    ],
    "postToolUse": [
      {
        "command": "powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/hooks/post-tool-use.ps1",
        "matcher": "Write",
        "timeout": 10
      }
    ],
    "stop": [
      {
        "command": "powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/hooks/stop.ps1",
        "timeout": 10,
        "loop_limit": 3
      }
    ]
  }
}
"""

UNIX_JSON = """{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      {
        "command": ".cursor/hooks/before-submit-prompt.sh",
        "timeout": 10
      }
    ],
    "preToolUse": [
      {
        "command": ".cursor/hooks/pre-tool-use.sh",
        "matcher": "Shell|Read|Write|Grep|Delete|Task",
        "timeout": 10
      }
    ],
    "postToolUse": [
      {
        "command": ".cursor/hooks/post-tool-use.sh",
        "matcher": "Write",
        "timeout": 10
      }
    ],
    "stop": [
      {
        "command": ".cursor/hooks/stop.sh",
        "timeout": 10,
        "loop_limit": 3
      }
    ]
  }
}
"""

PRE_PS1 = r"""# planning-with-files: preToolUse
# Cursor contract: permission allow|ask|deny (not decision)
$ErrorActionPreference = 'SilentlyContinue'
try { [void][Console]::In.ReadToEnd() } catch {}
$payload = @{ permission = 'allow' }
if (Test-Path -LiteralPath 'task_plan.md') {
  $head = @(Get-Content -LiteralPath 'task_plan.md' -TotalCount 30 -Encoding UTF8)
  $payload.agent_message = (@('[planning-with-files] task_plan.md (head):') + $head) -join "`n"
}
$payload | ConvertTo-Json -Compress -Depth 5
exit 0
"""

POST_PS1 = r"""# planning-with-files: postToolUse
$ErrorActionPreference = 'SilentlyContinue'
try { [void][Console]::In.ReadToEnd() } catch {}
if (Test-Path -LiteralPath 'task_plan.md') {
  @{ additional_context = '[planning-with-files] Update progress.md with what you just did. If a phase is now complete, update task_plan.md status.' } | ConvertTo-Json -Compress
} else {
  Write-Output '{}'
}
exit 0
"""

SUBMIT_PS1 = r"""# planning-with-files: beforeSubmitPrompt
$ErrorActionPreference = 'SilentlyContinue'
try { [void][Console]::In.ReadToEnd() } catch {}
if (-not (Test-Path -LiteralPath 'task_plan.md')) {
  Write-Output '{"continue":true}'
  exit 0
}
$head = @(Get-Content -LiteralPath 'task_plan.md' -TotalCount 50 -Encoding UTF8)
$progress = @()
if (Test-Path -LiteralPath 'progress.md') {
  $progress = @(Get-Content -LiteralPath 'progress.md' -Tail 20 -Encoding UTF8)
}
$msg = @(
  '[planning-with-files] ACTIVE PLAN - current state:'
  $head
  ''
  '=== recent progress ==='
  $progress
  ''
  '[planning-with-files] Read findings.md for research context. Continue from the current phase.'
) -join "`n"
@{ continue = $true; agent_message = $msg } | ConvertTo-Json -Compress -Depth 5
exit 0
"""

STOP_PS1 = r"""# planning-with-files: stop
# Never emit followup_message (Cursor auto-continues without user consent).
$ErrorActionPreference = 'SilentlyContinue'
try { [void][Console]::In.ReadToEnd() } catch {}
Write-Output '{}'
exit 0
"""

PRE_SH = """#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null || true
echo '{"permission":"allow"}'
exit 0
"""

POST_SH = """#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null || true
if [ -f task_plan.md ]; then
  echo '{"additional_context":"[planning-with-files] Update progress.md with what you just did. If a phase is now complete, update task_plan.md status."}'
else
  echo '{}'
fi
exit 0
"""

SUBMIT_SH = """#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null || true
echo '{"continue":true}'
exit 0
"""

STOP_SH = """#!/usr/bin/env bash
# stop: never emit followup_message
set -euo pipefail
cat >/dev/null || true
echo '{}'
exit 0
"""



def main() -> None:
    write(ROOT / "hooks.json", HOOKS_JSON)
    write(ROOT / "hooks.windows.json", HOOKS_JSON)
    write(ROOT / "hooks.unix.json", UNIX_JSON)
    write(HOOKS / "pre-tool-use.ps1", PRE_PS1)
    write(HOOKS / "post-tool-use.ps1", POST_PS1)
    write(HOOKS / "before-submit-prompt.ps1", SUBMIT_PS1)
    write(HOOKS / "stop.ps1", STOP_PS1)
    write(HOOKS / "pre-tool-use.sh", PRE_SH)
    write(HOOKS / "post-tool-use.sh", POST_SH)
    write(HOOKS / "before-submit-prompt.sh", SUBMIT_SH)
    write(HOOKS / "stop.sh", STOP_SH)
    for name in ("user-prompt-submit.ps1", "user-prompt-submit.sh"):
        p = HOOKS / name
        if p.exists():
            p.unlink()
            print(f"removed {p}")
    print("done")


if __name__ == "__main__":
    main()