"""Point provider toolsTo* at packages/tools/src/providerSchema.ts"""
import re
from pathlib import Path

def patch(path: str, fn_name: str, impl: str) -> None:
    p = Path(path)
    t = p.read_text(encoding="utf-8")
    if "providerSchema" in t:
        print(path, "already")
        return
    t = t.replace(
        "import type { ToolSpec } from '../../tools/src/index.ts'",
        "import type { ToolSpec } from '../../tools/src/index.ts'\n"
        f"import {{ {impl} as {impl}Impl }} from '../../tools/src/providerSchema.ts'",
    )
    pattern = rf"export function {fn_name}\(tools: ToolSpec\[\]\) \{{[\s\S]*?\n\}}"
    repl = (
        f"export function {fn_name}(tools: ToolSpec[] | Parameters<typeof {impl}Impl>[0]) {{\n"
        f"  return {impl}Impl(tools as Parameters<typeof {impl}Impl>[0])\n"
        f"}}"
    )
    t2, n = re.subn(pattern, repl, t, count=1)
    if n != 1:
        raise SystemExit(f"failed to patch {fn_name} in {path}")
    p.write_text(t2, encoding="utf-8", newline="\n")
    print("patched", path)

patch("packages/providers/src/openaiCompatible.ts", "toolsToOpenAI", "toolsToOpenAI")
patch("packages/providers/src/anthropic.ts", "toolsToAnthropic", "toolsToAnthropic")
print("done")