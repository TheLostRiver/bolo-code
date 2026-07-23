/** Skill 发现骨架 */

export type SkillMeta = {
  id: string
  name: string
  description?: string
  path: string
}

export type SkillSource = 'user' | 'project' | 'plugin' | 'bundled'

export function describeSkillLayout() {
  return {
    user: '~/.bolo/skills/<id>/SKILL.md',
    project: '.bolo/skills/<id>/SKILL.md',
    plugin: '<plugin>/skills/<id>/SKILL.md',
  }
}