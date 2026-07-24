/**
 * 权限门控单测 — 对照 docs/PERMISSIONS.md 矩阵
 * npx tsx scripts/test-permissions.ts
 */

import {
  decidePermission,
  getNextPermissionMode,
  matchBashPattern,
  matchPathGlob,
  type PermissionMode,
} from '../packages/permissions/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const cwd = process.cwd()

function d(
  mode: PermissionMode,
  toolName: string,
  toolInput: unknown = {},
  requiresPermission?: boolean,
) {
  return decidePermission({
    mode,
    toolName,
    toolInput,
    cwd,
    requiresPermission,
  })
}

async function main() {
  // cycle
  assert(getNextPermissionMode('default') === 'acceptEdits', 'cycle1')
  assert(getNextPermissionMode('bypassPermissions') === 'default', 'cycle2')

  // default
  assert(d('default', 'Read').behavior === 'allow', 'default read')
  assert(d('default', 'Bash', { command: 'ls' }, true).behavior === 'ask', 'default bash ask')
  assert(d('default', 'Write', { path: 'a.ts' }, true).behavior === 'ask', 'default write ask')
  assert(d('default', 'Edit', { path: 'a.ts', old_string: 'a', new_string: 'b' }, true).behavior === 'ask', 'default edit ask')

  // acceptEdits
  assert(
    d('acceptEdits', 'Write', { path: 'src/x.ts' }).behavior === 'allow',
    'accept write in cwd',
  )
  assert(
    d('acceptEdits', 'Edit', {
      path: 'src/x.ts',
      old_string: 'a',
      new_string: 'b',
    }).behavior === 'allow',
    'accept edit in cwd',
  )
  assert(
    d('acceptEdits', 'Bash', { command: 'rm -rf /' }).behavior === 'ask',
    'accept bash still ask',
  )

  // plan
  assert(d('plan', 'Read').behavior === 'allow', 'plan read')
  assert(d('plan', 'Write', { path: 'a.ts' }).behavior === 'deny', 'plan write deny')
  assert(d('plan', 'Edit', { path: 'a.ts', old_string: 'a', new_string: 'b' }).behavior === 'deny', 'plan edit deny')
  assert(d('plan', 'Bash', { command: 'echo' }).behavior === 'deny', 'plan bash deny')

  // bypass
  assert(d('bypassPermissions', 'Bash').behavior === 'allow', 'bypass bash')
  assert(d('bypassPermissions', 'Write', { path: 'a' }).behavior === 'allow', 'bypass write')
  assert(d('bypassPermissions', 'Edit', { path: 'a', old_string: 'x', new_string: 'y' }).behavior === 'allow', 'bypass edit')

  // mcp
  assert(d('default', 'mcp__x__y').behavior === 'ask', 'mcp default ask')
  assert(d('plan', 'mcp__x__y').behavior === 'deny', 'mcp plan deny')
  assert(d('bypassPermissions', 'mcp__x__y').behavior === 'allow', 'mcp bypass')

  // session always-allow rules（bypass 后、plan 仍 deny 写）
  const rules = {
    alwaysAllowToolNames: ['Bash'],
    alwaysAllowPrefixes: ['mcp__trusted'],
  }
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      cwd,
      requiresPermission: true,
      rules,
    }).behavior === 'allow',
    'rules: Bash always-allow',
  )
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'mcp__trusted__t',
      toolInput: {},
      cwd,
      rules,
    }).behavior === 'allow',
    'rules: prefix always-allow',
  )
  assert(
    decidePermission({
      mode: 'plan',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      cwd,
      requiresPermission: true,
      rules,
    }).behavior === 'deny',
    'rules: plan still denies Bash',
  )
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'Write',
      toolInput: { path: 'a.ts' },
      cwd,
      requiresPermission: true,
      rules,
    }).behavior === 'ask',
    'rules: unlisted tool still ask',
  )

  // path glob always-allow
  assert(matchPathGlob('src/foo.ts', 'src/**'), 'glob src/** matches')
  assert(matchPathGlob('a.ts', '**/*.ts'), 'glob **/*.ts root file')
  assert(!matchPathGlob('src/foo.ts', 'docs/**'), 'glob docs no match')

  const pathRules = {
    alwaysAllowToolNames: [] as string[],
    alwaysAllowPathGlobs: ['src/**', '**/*.md'],
  }
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'Write',
      toolInput: { path: 'src/a.ts', content: 'x' },
      cwd,
      requiresPermission: true,
      rules: pathRules,
    }).behavior === 'allow',
    'path glob: Write src/** allow',
  )
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'Edit',
      toolInput: { path: 'readme.md', old_string: 'a', new_string: 'b' },
      cwd,
      requiresPermission: true,
      rules: pathRules,
    }).behavior === 'allow',
    'path glob: Edit **/*.md allow',
  )
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'Write',
      toolInput: { path: 'other/x.ts', content: 'x' },
      cwd,
      requiresPermission: true,
      rules: pathRules,
    }).behavior === 'ask',
    'path glob: outside still ask',
  )
  assert(
    decidePermission({
      mode: 'plan',
      toolName: 'Write',
      toolInput: { path: 'src/a.ts', content: 'x' },
      cwd,
      requiresPermission: true,
      rules: pathRules,
    }).behavior === 'deny',
    'path glob: plan still deny write',
  )

  // bash prefix always-allow
  const bashRules = {
    alwaysAllowToolNames: [] as string[],
    alwaysAllowBashPrefixes: ['git ', 'npm test'],
  }
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      cwd,
      requiresPermission: true,
      rules: bashRules,
    }).behavior === 'allow',
    'bash prefix: git status allow',
  )
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'Bash',
      toolInput: { command: 'npm test -- --watch' },
      cwd,
      requiresPermission: true,
      rules: bashRules,
    }).behavior === 'allow',
    'bash prefix: npm test allow',
  )
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
      cwd,
      requiresPermission: true,
      rules: bashRules,
    }).behavior === 'ask',
    'bash prefix: other still ask',
  )
  assert(
    decidePermission({
      mode: 'plan',
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      cwd,
      requiresPermission: true,
      rules: bashRules,
    }).behavior === 'deny',
    'bash prefix: plan still deny',
  )
  assert(
    decidePermission({
      mode: 'bypassPermissions',
      toolName: 'Bash',
      toolInput: { command: 'anything' },
      cwd,
      rules: bashRules,
    }).behavior === 'allow',
    'bypass still full open',
  )

  // --- TP-PERM：规则匹配增强 / 硬 deny（非完整 yolo 分类器）---
  assert(matchBashPattern('git status', 'git '), 'bash pure prefix')
  assert(matchBashPattern('git', 'git *'), 'bash wildcard bare git')
  assert(matchBashPattern('git status', 'git *'), 'bash wildcard git status')
  assert(matchBashPattern('git status', 'git:*'), 'bash legacy :*')
  assert(
    matchBashPattern('npm test -- --watch', 'npm * --watch'),
    'bash multi-wildcard',
  )
  assert(!matchBashPattern('rm -rf /', 'git *'), 'bash wildcard no false match')

  const wildAllow = {
    alwaysAllowToolNames: [] as string[],
    alwaysAllowBashPrefixes: ['git *', 'npm:*'],
  }
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'Bash',
      toolInput: { command: 'git' },
      cwd,
      requiresPermission: true,
      rules: wildAllow,
    }).behavior === 'allow',
    'bash wild allow: bare git',
  )
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'Bash',
      toolInput: { command: 'npm install' },
      cwd,
      requiresPermission: true,
      rules: wildAllow,
    }).behavior === 'allow',
    'bash wild allow: npm:* legacy',
  )

  const denyRules = {
    alwaysAllowToolNames: ['Bash', 'Write'],
    alwaysDenyToolNames: ['Bash'],
    alwaysDenyPathGlobs: ['secrets/**'],
    alwaysDenyBashPrefixes: ['rm *'],
    alwaysDenyPrefixes: ['mcp__evil'],
  }
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'Bash',
      toolInput: { command: 'echo hi' },
      cwd,
      requiresPermission: true,
      rules: denyRules,
    }).behavior === 'deny',
    'deny tool name over always-allow',
  )
  assert(
    decidePermission({
      mode: 'bypassPermissions',
      toolName: 'Bash',
      toolInput: { command: 'echo hi' },
      cwd,
      rules: denyRules,
    }).behavior === 'deny',
    'deny wins over bypass',
  )
  assert(
    decidePermission({
      mode: 'acceptEdits',
      toolName: 'Write',
      toolInput: { path: 'secrets/key.pem', content: 'x' },
      cwd,
      requiresPermission: true,
      rules: denyRules,
    }).behavior === 'deny',
    'deny path glob over acceptEdits',
  )
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf tmp' },
      cwd,
      requiresPermission: true,
      rules: {
        alwaysAllowToolNames: [] as string[],
        alwaysDenyBashPrefixes: ['rm *'],
      },
    }).behavior === 'deny',
    'deny bash wildcard',
  )
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'mcp__evil__x',
      toolInput: {},
      cwd,
      rules: denyRules,
    }).behavior === 'deny',
    'deny tool prefix',
  )
  assert(
    decidePermission({
      mode: 'default',
      toolName: 'Write',
      toolInput: { path: 'src/ok.ts', content: 'x' },
      cwd,
      requiresPermission: true,
      rules: denyRules,
    }).behavior === 'allow',
    'deny rules: unlisted Write still always-allow',
  )

  console.log('PERMISSION TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})