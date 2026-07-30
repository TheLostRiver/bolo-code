/**
 * OUT-3: session-scoped spill store, lazy file pager, and presentation resume.
 */
import { strict as assert } from 'node:assert'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  cleanupToolResultSession,
  createSession,
  dualWriteSessionTranscript,
  loadTranscriptFile,
  projectToolPresentationsFromEntries,
  readToolResultFileChunk,
  resolveToolResultSessionDirectory,
  resumeSession,
  rewriteTranscriptFromMessages,
  writeToolResultFile,
  type BoloSession,
  type ToolResultChunkReader,
} from '../packages/core/src/index.ts'
import {
  createCliTuiViewStateFromMessages,
  type ChatMessage,
  type ToolPresentation,
  type ToolResultReference,
} from '../packages/shared/src/index.ts'
import {
  createToolResultFilePagerSource,
  RetainedOverlayHost,
} from '../packages/cli/src/index.ts'
import { measureTerminalText } from '../packages/cli/src/tui/terminalText.ts'

function presentation(
  reference: ToolResultReference,
  preview = 'bounded preview',
): ToolPresentation {
  return {
    summary: 'Read · large.txt · 1000 lines · truncated',
    preview,
    previewMode: 'head',
    originalChars: 100_000,
    originalLines: 1_000,
    retainedChars: 2_000,
    retainedLines: 20,
    truncated: true,
    overflow: true,
    fullResult: reference,
  }
}

function toolMessages(callId: string): ChatMessage[] {
  return [
    { role: 'user', content: 'read it' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: callId,
          name: 'Read',
          arguments: JSON.stringify({ path: 'large.txt' }),
        },
      ],
    },
    {
      role: 'tool',
      content: 'bounded provider result',
      tool_call_id: callId,
      name: 'Read',
    },
  ]
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await settle()
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`FAIL: ${message}`)
}

async function main(): Promise<void> {
  const root = path.resolve('.bolo-tmp', 'test-tool-output-file-pager')
  const cwd = path.join(root, 'workspace')
  const outside = path.join(root, 'outside')
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(cwd, { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  const previousConfigDir = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = path.join(root, 'user')
  const linkedSessionDir = resolveToolResultSessionDirectory(
    cwd,
    'linked-session',
  )

  try {
    const sourceText =
      `${'a'.repeat(255)}\u001b[31mRED\u001b[0m\n` +
      Array.from(
        { length: 2_000 },
        (_, index) =>
          `${String(index).padStart(4, '0')} 汉字🙂 ${'x'.repeat(160)}`,
      ).join('\n')
    const sessionDir = resolveToolResultSessionDirectory(
      cwd,
      'out-3-session',
    )
    const reference = await writeToolResultFile({
      cwd,
      sessionId: 'out-3-session',
      toolUseId: 'read/large',
      content: sourceText,
    })
    assert.ok(reference)

    const first = await readToolResultFileChunk({
      cwd,
      sessionId: 'out-3-session',
      reference,
      offset: 0,
      maxBytes: 257,
    })
    assert.equal(first.ok, true)
    assert.ok(first.ok && first.nextOffset <= 257)
    assert.ok(first.ok && first.nextOffset > 0)
    assert.ok(first.ok && !first.text.includes('\ufffd'))
    const second = first.ok
      ? await readToolResultFileChunk({
          cwd,
          sessionId: 'out-3-session',
          reference,
          offset: first.nextOffset,
          maxBytes: 257,
        })
      : first
    assert.equal(second.ok, true)
    assert.ok(
      first.ok &&
        second.ok &&
        Buffer.byteLength(first.text + second.text, 'utf8') <= 514,
      'chunk reader stays bounded and preserves UTF-8 boundaries',
    )

    let calls = 0
    let largestRequest = 0
    const instrumentedReader: ToolResultChunkReader = async (request) => {
      calls += 1
      largestRequest = Math.max(largestRequest, request.maxBytes ?? 0)
      return await readToolResultFileChunk(request)
    }
    const pager = createToolResultFilePagerSource({
      cwd,
      sessionId: 'out-3-session',
      reference,
      readChunk: instrumentedReader,
      chunkBytes: 257,
    })
    const page0 = await pager.loadPage({
      page: 0,
      columns: 18,
      pageSize: 5,
    })
    assert.equal(page0.ok, true)
    assert.ok(
      page0.ok &&
        page0.lines.length === 5 &&
        page0.lines.every((line) => measureTerminalText(line) <= 18) &&
        !page0.lines.join('').includes('\ufffd'),
      'lazy pager wraps CJK/emoji and a long logical line by terminal cells',
    )
    assert.ok(
      calls > 0 &&
        largestRequest <= 257 &&
        calls * largestRequest < reference.bytes,
      'opening the first page never reads the complete spill',
    )
    const ansiBoundaryPage = await pager.loadPage({
      page: 0,
      columns: 300,
      pageSize: 1,
    })
    assert.ok(
      ansiBoundaryPage.ok &&
        ansiBoundaryPage.lines[0]?.includes('RED') &&
        !ansiBoundaryPage.lines[0]?.includes('[31m'),
      'ANSI sequences split across chunks never leak terminal controls',
    )
    const page7 = await pager.loadPage({
      page: 7,
      columns: 18,
      pageSize: 5,
    })
    assert.equal(page7.ok, true)
    assert.ok(
      page7.ok &&
        page7.page === 7 &&
        page7.lines.length === 5 &&
        /汉|🙂/u.test(page7.lines.join('')),
    )

    const escapedPath = path.join(outside, 'escaped.txt')
    await fs.writeFile(escapedPath, 'outside', 'utf8')
    const escaped = await readToolResultFileChunk({
      cwd,
      sessionId: 'out-3-session',
      reference: {
        kind: 'session-file',
        path: escapedPath,
        bytes: 7,
      },
      offset: 0,
    })
    assert.deepEqual(
      escaped.ok ? undefined : escaped.reason,
      'path-escape',
    )

    const missing = await readToolResultFileChunk({
      cwd,
      sessionId: 'out-3-session',
      reference: {
        ...reference,
        path: path.join(sessionDir, 'missing-0123456789.txt'),
      },
      offset: 0,
    })
    assert.deepEqual(missing.ok ? undefined : missing.reason, 'missing')

    const corrupt = await readToolResultFileChunk({
      cwd,
      sessionId: 'out-3-session',
      reference: { ...reference, bytes: reference.bytes + 1 },
      offset: 0,
    })
    assert.deepEqual(
      corrupt.ok ? undefined : corrupt.reason,
      'size-mismatch',
    )

    const linkedTarget = path.join(outside, 'linked-session-target')
    await fs.mkdir(linkedTarget, { recursive: true })
    const linkedFile = path.join(
      linkedTarget,
      'linked-file-0123456789.txt',
    )
    await fs.writeFile(linkedFile, 'linked', 'utf8')
    await fs.symlink(linkedTarget, linkedSessionDir, 'junction')
    const linked = await readToolResultFileChunk({
      cwd,
      sessionId: 'linked-session',
      reference: {
        kind: 'session-file',
        path: path.join(
          linkedSessionDir,
          'linked-file-0123456789.txt',
        ),
        bytes: 6,
      },
      offset: 0,
    })
    assert.deepEqual(linked.ok ? undefined : linked.reason, 'symlink')

    let columns = 40
    const pending: Array<{
      columns: number
      resolve: (value: {
        ok: true
        page: number
        lines: string[]
        hasNext: boolean
        pageCount?: number
      }) => void
    }> = []
    const overlay = new RetainedOverlayHost({
      color: false,
      setOverlayState: () => {},
      requestRender: () => {},
      setInputEnabled: () => {},
      shouldKeepInput: () => true,
      getColumns: () => columns,
      getRows: () => 20,
      embedPagers: true,
    })
    const overlayResult = overlay.runLazyTextPager({
      key: 'stale',
      title: 'Stale guard',
      fallbackContent: 'bounded fallback',
      loadPage: (request) =>
        new Promise((resolve) => {
          pending.push({ columns: request.columns, resolve })
        }),
    })
    overlay.renderEmbeddedPager(columns)
    columns = 20
    overlay.renderEmbeddedPager(columns)
    assert.equal(pending.length, 2)
    pending[1]!.resolve({
      ok: true,
      page: 0,
      lines: ['new-width-20'],
      hasNext: false,
      pageCount: 1,
    })
    await settle()
    pending[0]!.resolve({
      ok: true,
      page: 0,
      lines: ['stale-width-40'],
      hasNext: false,
      pageCount: 1,
    })
    await settle()
    const staleScreen = overlay.renderEmbeddedPager(columns).join('\n')
    assert.ok(
      staleScreen.includes('new-width-20') &&
        !staleScreen.includes('stale-width-40'),
      'late async page results cannot overwrite the current resize',
    )
    overlay.handleInput('\u001b')
    assert.equal((await overlayResult).reason, 'quit')

    columns = 100
    const missingPager = createToolResultFilePagerSource({
      cwd,
      sessionId: 'out-3-session',
      reference: {
        ...reference,
        path: path.join(sessionDir, 'missing-0123456789.txt'),
      },
    })
    const missingOverlayResult = overlay.runLazyTextPager({
      key: 'missing',
      title: 'Missing result',
      fallbackContent: 'bounded fallback remains available',
      loadPage: missingPager.loadPage,
    })
    let missingScreen = ''
    await waitFor(() => {
      missingScreen = overlay
        .renderEmbeddedPager(columns)
        .join('\n')
      return (
        /Full result unavailable \(missing\)/u.test(missingScreen) &&
        missingScreen.includes('bounded fallback remains available')
      )
    }, 'missing spill fallback did not settle')
    assert.ok(
      /Full result unavailable \(missing\)/u.test(missingScreen) &&
        missingScreen.includes('bounded fallback remains available'),
      'missing spill degrades to an honest error plus bounded preview',
    )
    overlay.handleInput('\u001b')
    await missingOverlayResult

    const callId = 'read-resume'
    const jsonPath = path.join(root, 'resume-session.json')
    const session = await createSession({
      cwd,
      sessionId: 'resume-session',
      permissionMode: 'bypassPermissions',
      systemPrompt: false,
    })
    session.messages = toolMessages(callId)
    session.toolPresentations.set(callId, presentation(reference))
    await dualWriteSessionTranscript(session, jsonPath)
    await dualWriteSessionTranscript(session, jsonPath)
    let transcript = await loadTranscriptFile(
      jsonPath.replace(/\.json$/u, '.jsonl'),
    )
    const projected = projectToolPresentationsFromEntries(
      transcript.entries,
    )
    assert.deepEqual(projected.get(callId), presentation(reference))
    assert.equal(
      transcript.entries.filter(
        (entry) => entry.type === 'tool_presentation',
      ).length,
      1,
      'unchanged presentation side-channel is not appended twice',
    )
    assert.ok(
      session.messages.every(
        (message) => !message.content.includes(reference.path),
      ),
      'presentation references do not enter provider messages',
    )

    await rewriteTranscriptFromMessages(
      jsonPath.replace(/\.json$/u, '.jsonl'),
      session,
      { compactBoundarySummary: 'compact' },
    )
    transcript = await loadTranscriptFile(
      jsonPath.replace(/\.json$/u, '.jsonl'),
    )
    assert.deepEqual(
      projectToolPresentationsFromEntries(transcript.entries).get(callId),
      presentation(reference),
      'compact rewrite preserves the last presentation per call id',
    )

    await fs.appendFile(
      jsonPath.replace(/\.json$/u, '.jsonl'),
      `${JSON.stringify({
        type: 'tool_presentation',
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        callId: 'bad-ref',
        presentation: {
          ...presentation(reference),
          fullResult: { kind: 'session-file', path: '..\\escape', bytes: 1 },
        },
      })}\n`,
      'utf8',
    )
    transcript = await loadTranscriptFile(
      jsonPath.replace(/\.json$/u, '.jsonl'),
    )
    assert.equal(
      projectToolPresentationsFromEntries(transcript.entries).has(
        'bad-ref',
      ),
      false,
      'malformed presentation transcript lines fail closed',
    )
    await fs.appendFile(
      jsonPath.replace(/\.json$/u, '.jsonl'),
      `${JSON.stringify({
        type: 'tool_presentation',
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        callId: 'bad\ncall',
        presentation: presentation(reference),
      })}\n`,
      'utf8',
    )
    transcript = await loadTranscriptFile(
      jsonPath.replace(/\.json$/u, '.jsonl'),
    )
    assert.equal(
      projectToolPresentationsFromEntries(transcript.entries).has(
        'bad\ncall',
      ),
      false,
      'presentation call ids reject control characters',
    )

    const resumed = await resumeSession({
      idOrPath: jsonPath,
      cwd,
      reassembleSystem: false,
    })
    assert.deepEqual(
      resumed.session.toolPresentations.get(callId),
      presentation(reference),
    )
    const restoredView = createCliTuiViewStateFromMessages(
      resumed.session.messages,
      [...resumed.session.toolPresentations].map(
        ([restoredCallId, restoredPresentation]) => ({
          callId: restoredCallId,
          presentation: restoredPresentation,
        }),
      ),
    )
    const restoredTool = restoredView.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.kind === 'tool')
    assert.ok(
      restoredTool?.kind === 'tool' &&
        restoredTool.presentation?.fullResult?.path === reference.path,
      'resume projection rebuilds presentation without parsing tool text',
    )

    const siblingDir = resolveToolResultSessionDirectory(
      cwd,
      'sibling-session',
    )
    await fs.mkdir(siblingDir, { recursive: true })
    const siblingFile = path.join(
      siblingDir,
      'sibling-file-0123456789.txt',
    )
    await fs.writeFile(siblingFile, 'keep', 'utf8')
    const cleaned = await cleanupToolResultSession({
      cwd,
      sessionId: 'out-3-session',
    })
    assert.equal(cleaned.removed, true)
    await assert.rejects(fs.access(sessionDir))
    await fs.access(siblingFile)
    await fs.access(escapedPath)
    assert.ok(
      await cleanupToolResultSession({
        cwd,
        sessionId: 'out-3-session',
      }).then((result) => !result.removed),
      'cleanup is idempotent and only targets the requested session',
    )

    const fake = {
      id: 'fixture',
      messages: [],
      toolPresentations: new Map(),
    } as unknown as BoloSession
    assert.ok(fake.toolPresentations instanceof Map)
  } finally {
    await fs.unlink(linkedSessionDir).catch(() => undefined)
    await fs.rm(root, { recursive: true, force: true })
    if (previousConfigDir === undefined) {
      delete process.env.BOLO_CONFIG_DIR
    } else {
      process.env.BOLO_CONFIG_DIR = previousConfigDir
    }
  }

  console.log('PASS: OUT-3 file-backed tool pager and resume')
}

await main()
