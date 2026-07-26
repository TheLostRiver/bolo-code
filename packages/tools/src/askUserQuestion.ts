/**
 * AR-T3+ · AskUserQuestion 工具
 *
 * 模型遇到歧义时，现在只能猜，或者用自由文本发问再自己解析回答。
 * 这个工具把「问一句」变成结构化的一问一答。
 *
 * 职责边界（同 TodoWrite / ExitPlanMode）：
 * - 工具**不**画 UI、不碰终端，只调用 core 挂在 `ctx.extras.askUserQuestion`
 *   上的句柄；CLI 与 Desktop 各注入自己的实现
 * - 校验与投影全在 `packages/shared` 的契约里，本文件只做接线
 *
 * 三条硬规则，每条都对着一个真实的失败模式：
 *
 * ① **无人可问时不挂死。** 等一个永不 resolve 的 Promise 会让整个 runner
 *    停住，既不报错也不退出——比编答案还糟。照 `askPermission` 未注入时
 *    默认 `'deny'` 与 ExitPlanMode 未绑定时 `errorCode:'unavailable'` 的先例，
 *    收口成一个错误结果，让模型拿着它继续跑。
 *
 * ② **绝不编答案。** 结果不是算出来的，是人给的。会话里若出现一条
 *    「用户选择了 X」而用户根本没选过，后续每一轮都会把它当既定事实，
 *    而且永远不会报错。所以 UI 交回来的东西一律经契约层校验，对不上号就整条拒绝。
 *
 * ③ **必须与 signal 竞速。** 用户按了中断、或 UI 卡住，等待都要能断开。
 */

import {
  formatAskUserQuestionResult,
  projectAskUserQuestionAnswers,
  validateAskUserQuestionInput,
  ASK_MAX_QUESTIONS,
  ASK_MAX_OPTIONS,
  ASK_MIN_OPTIONS,
  type AskQuestion,
  type AskUserQuestionSelection,
} from '../../shared/src/index.ts'
import { buildTool, type BoloTool } from './types.ts'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

/** UI 交回的结果：答了 / 用户主动放弃 / 没人可问 */
export type AskUserQuestionOutcome =
  | { kind: 'answered'; selections: AskUserQuestionSelection[] }
  | { kind: 'cancelled' }
  | { kind: 'unavailable'; reason?: string }

/** core 挂在 ctx.extras.askUserQuestion 上的提问句柄 */
export type AskUserQuestionAskerRef = {
  ask: (
    questions: AskQuestion[],
    options?: { signal?: AbortSignal },
  ) => Promise<AskUserQuestionOutcome>
}

const NO_USER =
  'AskUserQuestion is unavailable: there is no user available to answer (non-interactive session). Do not wait — continue with your best judgement and state the assumption you made.'

function errorResult(output: string, errorCode: string) {
  return { ok: false as const, isError: true as const, output, errorCode }
}

export function createAskUserQuestionTool(): BoloTool {
  return buildTool({
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: [
      'Ask the user one or more multiple-choice questions to resolve ambiguity before you act.',
      'Use it to gather preferences, clarify an instruction that could reasonably be read two ways,',
      'or let the user pick between implementation approaches.',
      'Prefer it over guessing whenever the different readings would lead to materially different work —',
      'but do not use it for choices that have an obvious default, or for facts you can check yourself in the code.',
      'If you recommend one option, put it first and append "(Recommended)" to its label.',
      'Users can always answer in their own words instead of picking, so do not add an "Other" option yourself.',
    ].join(' '),
    // 问一个问题本身就是提示，不该在提示之前再弹一次权限框
    requiresPermission: false,
    // 对本机零副作用：不碰文件、不起进程、不出网
    isReadOnly: () => true,
    // 两个问题同时问会抢终端
    isConcurrencySafe: () => false,
    // 用户中断时直接丢掉待答的问题
    interruptBehavior: () => 'cancel',
    inputJSONSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: `The questions to ask (1-${ASK_MAX_QUESTIONS})`,
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description:
                  'The full question, specific enough to answer without further context',
              },
              header: {
                type: 'string',
                description:
                  'Very short label shown as a chip (max 12 chars), e.g. "Database"',
              },
              multiSelect: {
                type: 'boolean',
                description:
                  'true when several answers may be chosen at once; default false',
              },
              options: {
                type: 'array',
                description: `The choices (${ASK_MIN_OPTIONS}-${ASK_MAX_OPTIONS}), each distinct`,
                items: {
                  type: 'object',
                  properties: {
                    label: {
                      type: 'string',
                      description: 'Short display text for this choice',
                    },
                    description: {
                      type: 'string',
                      description:
                        'What choosing this means or what will happen — include the trade-off',
                    },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question', 'header', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    async call(input, ctx) {
      // 先校验再打扰用户：问得不成样子的问题不该送到人面前
      const validation = validateAskUserQuestionInput(input)
      if (!validation.ok) {
        return errorResult(
          `InputValidationError: ${validation.detail}`,
          validation.code,
        )
      }

      const asker = ctx.extras?.askUserQuestion as
        | AskUserQuestionAskerRef
        | undefined
      if (!asker || typeof asker.ask !== 'function') {
        return errorResult(NO_USER, 'unavailable')
      }

      if (ctx.signal?.aborted) {
        return errorResult(
          'AskUserQuestion was interrupted before the user could answer.',
          'aborted',
        )
      }

      // 与 signal 竞速：UI 卡住或用户中断时都要能断开，
      // 绝不能留下一个永远 pending 的等待占住 runner
      let outcome: AskUserQuestionOutcome
      try {
        outcome = await raceWithAbort(
          asker.ask(validation.questions, {
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
          ctx.signal,
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return errorResult(`AskUserQuestion failed: ${msg}`, 'ask_failed')
      }

      if (outcome.kind === 'unavailable') {
        return errorResult(
          outcome.reason ? `${NO_USER} (${outcome.reason})` : NO_USER,
          'unavailable',
        )
      }
      if (outcome.kind === 'cancelled') {
        return errorResult(
          'The user declined to answer. Do not ask again — continue with your best judgement and say what you assumed.',
          'cancelled',
        )
      }

      // UI 交回来的东西同样不可信：对不上号就整条拒绝，绝不放行一条
      // 看起来合理、实则没发生过的「用户选择」
      const projected = projectAskUserQuestionAnswers(
        validation.questions,
        outcome.selections,
      )
      if (!projected.ok) {
        return errorResult(
          `AskUserQuestion got an answer that does not match what was asked (${projected.detail}). Nothing was recorded.`,
          projected.code,
        )
      }

      return {
        ok: true,
        output: `The user answered:\n${formatAskUserQuestionResult(projected.answers)}`,
      }
    },
  })
}

/** 与 abort 竞速；signal 触发时以 aborted 收口而不是继续等 */
function raceWithAbort(
  p: Promise<AskUserQuestionOutcome>,
  signal?: AbortSignal,
): Promise<AskUserQuestionOutcome> {
  if (!signal) return p
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (v: AskUserQuestionOutcome) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(v)
    }
    const onAbort = () => finish({ kind: 'cancelled' })
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(finish, (e) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(e)
    })
  })
}
