/**
 * Session-backed runtime transport for production consumers such as Desktop.
 *
 * The client deliberately exchanges `unknown` across its transport boundary.
 * This adapter is the matching core boundary: commands are parsed before they
 * can reach the executor, while snapshots are rebuilt from the current session
 * on every query.
 */
import {
  createRuntimeProtocolHello,
  parseRuntimeCommand,
} from '../../shared/src/runtimeProtocol.ts'
import type { RuntimeTransport } from '../../shared/src/runtimeClient.ts'
import {
  executeRuntimeCommand,
  type RuntimeCommandSession,
} from './runtimeCommand.ts'
import { buildRuntimeSnapshot } from './runtimeSnapshot.ts'

export type RuntimeSessionResolver = () =>
  | RuntimeCommandSession
  | Promise<RuntimeCommandSession>

export function createSessionRuntimeTransport(
  resolveSession: RuntimeSessionResolver,
): RuntimeTransport {
  return {
    async hello() {
      return createRuntimeProtocolHello()
    },

    async query() {
      return buildRuntimeSnapshot(await resolveSession())
    },

    async command(input) {
      const parsed = parseRuntimeCommand(input)
      if (!parsed.ok) {
        throw new Error(
          `runtime command rejected (${parsed.code}): ${parsed.detail}`,
        )
      }
      return await executeRuntimeCommand(await resolveSession(), parsed.value)
    },
  }
}
