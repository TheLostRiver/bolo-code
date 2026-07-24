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
  assert(findToolByName(tools, 'Glob')?.isConcurrencySafe({}), 'Glob concurrent')
  assert(findToolByName(tools, 'Read')?.isReadOnly({}), 'Read readonly')
  assert(!findToolByName(tools, 'Write')?.isConcurrencySafe({}), 'Write not concurrent')
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
  assert(!escape.ok && escape.isError, 'escape cwd fails')
  assert(String(escape.output).includes('escapes cwd'), 'escape error message')

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

  console.log('TOOL CALLING ALIGN TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})