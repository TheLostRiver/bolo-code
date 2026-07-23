# planning-with-files: stop
# Cursor stop hook: followup_message 会在用户未确认时自动续跑 agent，体验像“卡住/鬼打墙”。
# 因此本 hook 永远只返回 {}，不注入 followup。
$ErrorActionPreference = 'SilentlyContinue'
try { [void][Console]::In.ReadToEnd() } catch {}
Write-Output '{}'
exit 0