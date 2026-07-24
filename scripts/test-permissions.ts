/**
 * 权限门控单测 — 对照 docs/PERMISSIONS.md 矩阵
 * npx tsx scripts/test-permissions.ts
 */

import {
  decidePermission,
  getNextPermissionMode,
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

  // acceptEdits
  assert(
    d('acceptEdits', 'Write', { path: 'src/x.ts' }).behavior === 'allow',
    'accept write in cwd',
  )
  assert(
    d('acceptEdits', 'Bash', { command: 'rm -rf /' }).behavior === 'ask',
    'accept bash still ask',
  )

  // plan
  assert(d('plan', 'Read').behavior === 'allow', 'plan read')
  assert(d('plan', 'Write', { path: 'a.ts' }).behavior === 'deny', 'plan write deny')
  assert(d('plan', 'Bash', { command: 'echo' }).behavior === 'deny', 'plan bash deny')

  // bypass
  assert(d('bypassPermissions', 'Bash').behavior === 'allow', 'bypass bash')
  assert(d('bypassPermissions', 'Write', { path: 'a' }).behavior === 'allow', 'bypass write')

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

  console.log('PERMISSION TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})