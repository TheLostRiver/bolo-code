/**
 * 配置路径 — 对照 HelsincyCode getClaudeConfigHomeDir
 *
 * 全局: BOLO_CONFIG_DIR ?? ~/.bolo
 * 项目: <cwd>/.bolo
 */

import { homedir } from 'node:os'
import path from 'node:path'

export const BOLO_DIR_NAME = '.bolo'

export function getBoloHomeDir(): string {
  const explicit = process.env.BOLO_CONFIG_DIR?.trim()
  if (explicit) return path.normalize(explicit)
  return path.join(homedir(), BOLO_DIR_NAME)
}

export function getProjectBoloDir(cwd: string): string {
  return path.join(path.resolve(cwd), BOLO_DIR_NAME)
}

export type BoloLayoutPaths = {
  root: string
  configJson: string
  mcpJson: string
  hooksJson: string
  skillsDir: string
  pluginsDir: string
  sessionsDir: string
  /** 项目/用户 rules 目录（`.bolo/rules`） */
  rulesDir: string
  /** 项目/用户 agent 定义目录（`.bolo/agents`） */
  agentsDir: string
}

export function layoutPaths(root: string): BoloLayoutPaths {
  return {
    root,
    configJson: path.join(root, 'config.json'),
    mcpJson: path.join(root, 'mcp.json'),
    hooksJson: path.join(root, 'hooks.json'),
    skillsDir: path.join(root, 'skills'),
    pluginsDir: path.join(root, 'plugins'),
    sessionsDir: path.join(root, 'sessions'),
    rulesDir: path.join(root, 'rules'),
    agentsDir: path.join(root, 'agents'),
  }
}

export function getUserLayout(): BoloLayoutPaths {
  return layoutPaths(getBoloHomeDir())
}

export function getProjectLayout(cwd: string): BoloLayoutPaths {
  return layoutPaths(getProjectBoloDir(cwd))
}

/** 文档/错误提示用 */
export function describeLayout(): {
  user: BoloLayoutPaths
  envOverride: string
  projectRelative: string
} {
  return {
    user: getUserLayout(),
    envOverride: 'BOLO_CONFIG_DIR',
    projectRelative: `${BOLO_DIR_NAME}/`,
  }
}