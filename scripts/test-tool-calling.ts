/**
 * Tool calling 对齐测试 — buildTool / schema / concurrent partition / Glob
 */
import {
  buildTool,
  createBuiltinTools,
  findToolByName,
  validateAgainstJsonSchema,
  formatToolUseError,
} from '../packages/tools/src/index.ts'
import { partitionToolCalls } from '../packages/core/src/toolOrchestration.ts'
import { runToolUse } from '../packages/core/src/toolExecution.ts'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

async function main() {
  const tools = createBuiltinTools()
  assert(findToolByName(tools, 'Bash'), 'has Bash')
  assert(findToolByName(tools, 'Edit'), 'has Edit')
  assert(findToolByName(tools, 'Glob')?.isConcurrencySafe({}), 'Glob concurrent')
  assert(findToolByName(tools, 'Read')?.isReadOnly({}), 'Read readonly')
  assert(!findToolByName(tools, 'Write')?.isConcurrencySafe({}), 'Write not concurrent')
  assert(!findToolByName(tools, 'Edit')?.isConcurrencySafe({}), 'Edit not concurrent')
  assert(findToolByName(tools, 'Skill')?.isConcurrencySafe({}), 'Skill concurrent')

  const bash = findToolByName(tools, 'Bash')!
  const bad = validateAgainstJsonSchema(bash.inputJSONSchema, {})
  assert(!bad.success, 'bash missing command fails schema')

  const ok = validateAgainstJsonSchema(bash.inputJSONSchema, { command: 'echo x' })
  assert(ok.success, 'bash schema ok')

  // partition: Read,Glob concurrent together; Write alone
  const batches = partitionToolCalls(
    [
      { id: '1', name: 'Read', input: { path: 'a' } },
      { id: '2', name: 'Glob', input: { pattern: '**/*' } },
      { id: '3', name: 'Write', input: { path: 'a', content: 'b' } },
      { id: '4', name: 'Grep', input: { pattern: 'x' } },
    ],
    tools,
  )
  assert(batches.length === 3, `expected 3 batches got ${batches.length}`)
  assert(batches[0]!.concurrent && batches[0]!.blocks.length === 2, 'batch0 concurrent read+glob')
  assert(!batches[1]!.concurrent, 'batch1 write serial')
  assert(batches[2]!.concurrent, 'batch2 grep concurrent')

  // unknown tool
  const unknown = await runToolUse(
    { id: 'u1', name: 'NoSuchTool', input: {} },
    {
      sessionId: 's',
      cwd: process.cwd(),
      hooks: {},
      permissionMode: 'bypassPermissions',
      askPermission: async () => 'allow',
      tools,
    },
  )
  assert(unknown.toolResultMessage.content.includes('No such tool'), 'unknown tool error')
  assert(unknown.toolResultMessage.content.includes('tool_use_error'), 'xml error tag')

  // schema fail
  const schemaFail = await runToolUse(
    { id: 'u2', name: 'Bash', input: {} },
    {
      sessionId: 's',
      cwd: process.cwd(),
      hooks: {},
      permissionMode: 'bypassPermissions',
      askPermission: async () => 'allow',
      tools,
    },
  )
  assert(schemaFail.toolResultMessage.content.includes('InputValidationError'), 'schema error')

  // Glob real
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-glob-'))
  await fs.writeFile(path.join(tmp, 'a.ts'), 'export const x = 1\n', 'utf8')
  await fs.writeFile(path.join(tmp, 'b.md'), 'hi\n', 'utf8')
  const glob = findToolByName(tools, 'Glob')!
  const g = await glob.call({ pattern: '**/*.ts' }, { cwd: tmp })
  assert(g.ok && g.output.includes('a.ts'), 'glob finds a.ts')

  // Grep real
  const grept = findToolByName(tools, 'Grep')!
  const gr = await grept.call({ pattern: 'export' }, { cwd: tmp })
  assert(gr.ok && gr.output.includes('a.ts'), 'grep finds export')

  // apply_patch: Add + Update under temp cwd
  const patchTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-patch-'))
  const apply = findToolByName(tools, 'apply_patch')!
  const addRes = await apply.call(
    {
      patch: `*** Begin Patch
*** Add File: hello.txt
+hello
*** End Patch`,
    },
    { cwd: patchTmp },
  )
  assert(addRes.ok, `add patch ok: ${addRes.output}`)
  const added = await fs.readFile(path.join(patchTmp, 'hello.txt'), 'utf8')
  assert(added.includes('hello'), 'add file content')

  const updRes = await apply.call(
    {
      patch: `*** Begin Patch
*** Update File: hello.txt
@@
-hello
+hello world
*** End Patch`,
    },
    { cwd: patchTmp },
  )
  assert(updRes.ok, `update patch ok: ${updRes.output}`)
  const updated = await fs.readFile(path.join(patchTmp, 'hello.txt'), 'utf8')
  assert(updated.includes('hello world'), 'update file content')

  const escape = await apply.call(
    {
      patch: `*** Begin Patch
*** Add File: ../escape.txt
+nope
*** End Patch`,
    },
    { cwd: patchTmp },
  )
  assert(escape.ok === false && escape.isError, 'escape cwd fails')
  assert(String(escape.output).includes('escapes cwd'), 'escape error message')

  // Move / Rename File
  await fs.writeFile(path.join(patchTmp, 'from.txt'), 'move-me\n', 'utf8')
  const moveRes = await apply.call(
    {
      patch: `*** Begin Patch
*** Move File: from.txt -> to/dir.txt
*** End Patch`,
    },
    { cwd: patchTmp },
  )
  assert(moveRes.ok, `move patch ok: ${moveRes.output}`)
  const moved = await fs.readFile(path.join(patchTmp, 'to', 'dir.txt'), 'utf8')
  assert(moved.includes('move-me'), 'move content')
  let fromGone = false
  try {
    await fs.access(path.join(patchTmp, 'from.txt'))
  } catch {
    fromGone = true
  }
  assert(fromGone, 'move removes source')

  // Edit: unique replace + not unique + not found + abort
  const editTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-edit-'))
  await fs.writeFile(path.join(editTmp, 'e.txt'), 'one two one\n', 'utf8')
  const edit = findToolByName(tools, 'Edit')!

  const notFound = await edit.call(
    { path: 'e.txt', old_string: 'zzz', new_string: 'y' },
    { cwd: editTmp },
  )
  assert(!notFound.ok && String(notFound.output).includes('not found'), 'edit not found')

  const multi = await edit.call(
    { path: 'e.txt', old_string: 'one', new_string: 'ONE' },
    { cwd: editTmp },
  )
  assert(!multi.ok && String(multi.output).includes('matched 2'), 'edit not unique')

  const once = await edit.call(
    { path: 'e.txt', old_string: 'two', new_string: 'TWO' },
    { cwd: editTmp },
  )
  assert(once.ok, `edit unique ok: ${once.output}`)
  const afterOnce = await fs.readFile(path.join(editTmp, 'e.txt'), 'utf8')
  assert(afterOnce.includes('one TWO one'), 'edit unique content')

  const all = await edit.call(
    { path: 'e.txt', old_string: 'one', new_string: '1', replace_all: true },
    { cwd: editTmp },
  )
  assert(all.ok && String(all.output).includes('2'), `edit replace_all: ${all.output}`)
  const afterAll = await fs.readFile(path.join(editTmp, 'e.txt'), 'utf8')
  assert(afterAll === '1 TWO 1\n', `edit replace_all content: ${JSON.stringify(afterAll)}`)

  const ac = new AbortController()
  ac.abort()
  const aborted = await edit.call(
    { path: 'e.txt', old_string: '1', new_string: 'x' },
    { cwd: editTmp, signal: ac.signal },
  )
  assert(!aborted.ok && aborted.errorCode === 'aborted', 'edit respects abort')

  const readAbort = await findToolByName(tools, 'Read')!.call(
    { path: 'e.txt' },
    { cwd: editTmp, signal: ac.signal },
  )
  assert(!readAbort.ok && readAbort.errorCode === 'aborted', 'read respects abort')

  // buildTool defaults
  const custom = buildTool({
    name: 'Custom',
    description: 'c',
    inputJSONSchema: { type: 'object', properties: {} },
    async call() {
      return { ok: true, output: 'ok' }
    },
  })
  assert(custom.isConcurrencySafe({}) === false, 'default not concurrent')
  assert(custom.requiresPermission === true, 'default requires permission')

  // C6: 超长 tool_result 截断
  const longOut = 'x'.repeat(120)
  const bigTool = buildTool({
    name: 'BigOut',
    description: 'long',
    requiresPermission: false,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    inputJSONSchema: { type: 'object', properties: {} },
    async call() {
      return { ok: true, output: longOut }
    },
  })
  const bigRes = await runToolUse(
    { id: 'big1', name: 'BigOut', input: {} },
    {
      sessionId: 's',
      cwd: process.cwd(),
      hooks: {},
      permissionMode: 'bypassPermissions',
      askPermission: async () => 'allow',
      tools: [bigTool],
      maxToolResultChars: 50,
      spillTruncatedToolResults: false,
    },
  )
  const bigContent = bigRes.toolResultMessage.content
  assert(bigContent.includes('truncated'), 'long output truncated marker')
  assert(bigContent.includes('full result not stored in transcript'), 'trunc note')
  assert(bigContent.length < longOut.length, 'content shorter than full')
  assert(bigContent.startsWith('x'.repeat(50)), 'keeps first maxChars')

  console.log('TOOL CALLING ALIGN TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})