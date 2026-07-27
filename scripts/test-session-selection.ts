/**
 * OI-06E: active session selection/restore contract.
 *
 * Run: npm run test:session-selection
 */
import assert from 'node:assert/strict'

import {
  createActiveSessionManager,
  scopeSessionRequestId,
} from '../packages/core/src/sessionSelection.ts'

type StubSession = {
  id: string
  phase: string
}

function stub(id: string, phase = 'ready'): StubSession {
  return { id, phase }
}

async function main() {
  const disposed: string[] = []
  const beforeReplace: string[] = []
  const loaded: string[] = []
  const sessions = new Map<string, StubSession>([
    ['a', stub('a')],
    ['b', stub('b')],
    ['c', stub('c')],
  ])

  const manager = createActiveSessionManager<StubSession>({
    create: async () => sessions.get('a')!,
    resume: async (sessionId) => {
      loaded.push(sessionId)
      const found = sessions.get(sessionId)
      if (!found) throw new Error(`missing ${sessionId}`)
      return found
    },
    beforeReplace: async (current) => {
      beforeReplace.push(current.id)
    },
    dispose: async (target, reason) => {
      disposed.push(`${target.id}:${reason}`)
    },
    nextScope: (() => {
      let seq = 0
      return () => `scope_${++seq}`
    })(),
  })

  const initial = await manager.ensure()
  assert.equal(initial.id, 'a')
  assert.equal(manager.current()?.id, 'a')
  assert(manager.isCurrent(initial, 'scope_1'))

  const invalid = await manager.select({ sessionId: '   ' })
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.code, 'invalid_request')
  assert.deepEqual(loaded, [], 'invalid selection never loads')

  const unchanged = await manager.select({ sessionId: 'a' })
  assert.equal(unchanged.ok, true)
  if (unchanged.ok) assert.equal(unchanged.status, 'unchanged')
  assert.deepEqual(loaded, [], 'selecting active session is a no-op')

  for (const phase of [
    'starting',
    'running',
    'awaiting_permission',
    'compacting',
    'stopping',
    'future_unknown_phase',
  ]) {
    initial.phase = phase
    const blocked = await manager.select({ sessionId: 'b' })
    assert.equal(blocked.ok, false, `${phase} blocks replacement`)
    if (!blocked.ok) assert.equal(blocked.code, 'active_session_busy')
  }
  initial.phase = 'ready'
  assert.deepEqual(loaded, [], 'busy selection never starts target loading')

  initial.phase = 'running'
  const blockedRecreate = await manager.recreate()
  assert.equal(blockedRecreate.ok, false)
  if (!blockedRecreate.ok) {
    assert.equal(blockedRecreate.code, 'active_session_busy')
  }
  initial.phase = 'ready'

  const missing = await manager.select({ sessionId: 'missing' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.code, 'load_failed')
  assert.equal(manager.current()?.id, 'a', 'load failure preserves active session')
  assert.deepEqual(beforeReplace, [], 'load failure never cancels old interaction')

  sessions.set('mismatch', stub('different-id'))
  const mismatch = await manager.select({ sessionId: 'mismatch' })
  assert.equal(mismatch.ok, false)
  if (!mismatch.ok) assert.equal(mismatch.code, 'session_id_mismatch')
  assert.equal(manager.current()?.id, 'a')
  assert(
    disposed.includes('different-id:candidate_rejected'),
    'mismatched candidate is disposed',
  )

  const selected = await manager.select({ sessionId: 'b' })
  let selectedScope = ''
  assert.equal(selected.ok, true)
  if (selected.ok) {
    assert.equal(selected.status, 'selected')
    assert.equal(selected.previousSessionId, 'a')
    assert.equal(selected.session.id, 'b')
    selectedScope = selected.scope
    assert.notEqual(selectedScope, 'scope_1')
  }
  assert.equal(manager.current()?.id, 'b')
  assert.deepEqual(beforeReplace, ['a'])
  assert(disposed.includes('a:replace'))
  assert(manager.isCurrent(sessions.get('b')!, selectedScope))
  assert(!manager.isCurrent(initial, 'scope_1'))

  const recreated = await manager.recreate()
  assert.equal(recreated.ok, true)
  if (recreated.ok) {
    assert.equal(recreated.status, 'created')
    assert.equal(recreated.previousSessionId, 'b')
    assert.equal(recreated.session.id, 'a')
  }
  assert.equal(manager.current()?.id, 'a')
  assert(disposed.includes('b:replace'))

  const failedActivationDisposals: string[] = []
  const failedActivation = createActiveSessionManager<StubSession>({
    create: async () => stub('old'),
    resume: async () => stub('next'),
    dispose: async (target, reason) => {
      failedActivationDisposals.push(`${target.id}:${reason}`)
      if (target.id === 'old' && reason === 'replace') {
        throw new Error('injected teardown failure')
      }
    },
  })
  const old = await failedActivation.ensure()
  const rejectedActivation = await failedActivation.select({
    sessionId: 'next',
  })
  assert.equal(rejectedActivation.ok, false)
  if (!rejectedActivation.ok) {
    assert.equal(rejectedActivation.code, 'activation_failed')
  }
  assert.equal(failedActivation.current(), old)
  assert(
    failedActivationDisposals.includes('next:candidate_rejected'),
    'candidate is disposed when old-session teardown fails',
  )

  let concurrentLoads = 0
  let maxConcurrentLoads = 0
  const serialManager = createActiveSessionManager<StubSession>({
    create: async () => stub('root'),
    resume: async (sessionId) => {
      concurrentLoads += 1
      maxConcurrentLoads = Math.max(maxConcurrentLoads, concurrentLoads)
      await Promise.resolve()
      concurrentLoads -= 1
      return stub(sessionId)
    },
    dispose: async () => {},
  })
  await serialManager.ensure()
  const [toB, toC] = await Promise.all([
    serialManager.select({ sessionId: 'b' }),
    serialManager.select({ sessionId: 'c' }),
  ])
  assert.equal(toB.ok, true)
  assert.equal(toC.ok, true)
  assert.equal(maxConcurrentLoads, 1, 'selection loads are serialized')
  assert.equal(serialManager.current()?.id, 'c', 'last queued selection wins')

  const requestA = scopeSessionRequestId('session-a:1', 'tool-use-1')
  const requestB = scopeSessionRequestId('session-b:2', 'tool-use-1')
  assert.notEqual(
    requestA,
    requestB,
    'same raw approval id cannot collide across session scopes',
  )
  assert.equal(
    scopeSessionRequestId('session-a:1', 'tool-use-1'),
    requestA,
    'scoping is stable inside one session instance',
  )

  await manager.close()
  assert.equal(manager.current(), null)
  assert(disposed.includes('a:shutdown'))

  console.log('PASS: active session selection contract')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
