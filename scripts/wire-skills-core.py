"""Wire skill catalog + Skill tool into packages/core/src/index.ts"""
from pathlib import Path

p = Path("packages/core/src/index.ts")
t = p.read_text(encoding="utf-8")

t = t.replace(
    "import { skillsToSystemPrompt } from '../../skills/src/index.ts'",
    "import { formatSkillCatalog, type LoadedSkill } from '../../skills/src/index.ts'",
)
t = t.replace("skillsToSystemPrompt", "formatSkillCatalog")

if "skills?: LoadedSkill[]" not in t:
    t = t.replace(
        """  compactSummarizer?: CompactSummarizer
  source?: SessionStartSource
  onEvent?: (e: SessionEvent) => void
}

export type BoloSession = {
  id: string
  cwd: string
  phase: SessionPhase
  messages: ChatMessage[]
  hooks: HooksConfig
  provider: LlmProvider
  deps: QueryDeps
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  compactSummarizer?: CompactSummarizer
  onEvent: (e: SessionEvent) => void
}
""",
        """  compactSummarizer?: CompactSummarizer
  /** 会话 skill 全文表；默认不进 system，仅 Skill 工具按需加载 */
  skills?: LoadedSkill[]
  source?: SessionStartSource
  onEvent?: (e: SessionEvent) => void
}

export type BoloSession = {
  id: string
  cwd: string
  phase: SessionPhase
  messages: ChatMessage[]
  hooks: HooksConfig
  provider: LlmProvider
  deps: QueryDeps
  permissionMode: PermissionMode
  askPermission: AskPermissionFn
  compactSummarizer?: CompactSummarizer
  skills: LoadedSkill[]
  onEvent: (e: SessionEvent) => void
}
""",
    )

if "skills: opts.skills" not in t:
    t = t.replace(
        """    compactSummarizer: opts.compactSummarizer,
    onEvent: opts.onEvent ?? (() => {}),
  }
""",
        """    compactSummarizer: opts.compactSummarizer,
    skills: opts.skills ?? [],
    onEvent: opts.onEvent ?? (() => {}),
  }
""",
    )

if "skills: session.skills" not in t:
    t = t.replace(
        """    permissionMode: session.permissionMode,
    askPermission: session.askPermission,
    maxTurns: options?.maxTurns ?? 8,
    querySource: options?.querySource ?? 'repl_main_thread',
    onEvent: (e) => mapLoopEvent(session, e),
  })
""",
        """    permissionMode: session.permissionMode,
    askPermission: session.askPermission,
    skills: session.skills,
    maxTurns: options?.maxTurns ?? 8,
    querySource: options?.querySource ?? 'repl_main_thread',
    onEvent: (e) => mapLoopEvent(session, e),
  })
""",
    )

old_ws = """  if (opts.injectSkills !== false && workspace.skills.length) {
    const block = formatSkillCatalog(workspace.skills)
    if (block) {
      session.messages.unshift({ role: 'system', content: block })
    }
  }

  return { session, workspace }
}
"""
# may still be skillsToSystemPrompt if replace failed earlier
old_ws2 = old_ws.replace("formatSkillCatalog", "skillsToSystemPrompt")
new_ws = """  // 全文注册表给 Skill 工具；上下文只注入目录索引（防 token 爆炸）
  session.skills = workspace.skills
  if (opts.injectSkills !== false && workspace.skills.length) {
    const catalog = formatSkillCatalog(workspace.skills)
    if (catalog) {
      session.messages.unshift({ role: 'system', content: catalog })
    }
  }

  return { session, workspace }
}
"""
if "session.skills = workspace.skills" not in t:
    if old_ws in t:
        t = t.replace(old_ws, new_ws)
    elif old_ws2 in t:
        t = t.replace(old_ws2, new_ws)
    else:
        print("WARN workspace inject not found")

p.write_text(t, encoding="utf-8", newline="\n")
print("ok formatSkillCatalog", "formatSkillCatalog" in t)
print("ok session.skills pass", "skills: session.skills" in t)
print("ok catalog inject", "session.skills = workspace.skills" in t)