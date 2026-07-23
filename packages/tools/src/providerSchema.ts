/**
 * 将 BoloTool / 兼容 ToolSpec 转为 OpenAI tools 数组
 */

import { createBuiltinTools } from './builtins.ts'
import type { BoloTool, JsonSchema } from './types.ts'
import type { ToolSpec } from './builtins.ts'

function defaultToolParameters(name: string): JsonSchema {
  switch (name) {
    case 'Bash':
      return {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
        },
        required: ['command'],
      }
    case 'Read':
      return {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to cwd' },
        },
        required: ['path'],
      }
    case 'Write':
    case 'apply_patch':
      return {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      }
    case 'Glob':
      return {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
        },
        required: ['pattern'],
      }
    case 'Grep':
      return {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['pattern'],
      }
    case 'Skill':
      return {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'Skill id from the Available Skills catalog',
          },
        },
        required: ['skill'],
      }
    default:
      return { type: 'object', properties: {} }
  }
}

export type ToolLike =
  | BoloTool
  | ToolSpec
  | {
      name: string
      description: string
      inputJSONSchema?: JsonSchema
    }

export function toolsToOpenAI(tools: ToolLike[]) {
  return tools.map((t) => {
    const schema =
      'inputJSONSchema' in t && t.inputJSONSchema
        ? t.inputJSONSchema
        : defaultToolParameters(t.name)
    return {
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: schema,
      },
    }
  })
}

export function toolsToAnthropic(tools: ToolLike[]) {
  return tools.map((t) => {
    const schema =
      'inputJSONSchema' in t && t.inputJSONSchema
        ? t.inputJSONSchema
        : defaultToolParameters(t.name)
    return {
      name: t.name,
      description: t.description,
      input_schema: schema,
    }
  })
}

export function defaultToolsForProviders(): BoloTool[] {
  return createBuiltinTools()
}