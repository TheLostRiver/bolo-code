/**
 * 初始化全局 ~/.bolo 与当前项目 .bolo
 * 运行：npx tsx scripts/bolo-init.ts [cwd]
 */

import path from 'node:path'
import {
  ensureAllLayouts,
  getBoloHomeDir,
  getProjectBoloDir,
  describeLayout,
} from '../packages/config/src/index.ts'

async function main() {
  const cwd = path.resolve(process.argv[2] ?? process.cwd())
  const { user, project } = await ensureAllLayouts(cwd, { writeDefaults: true })

  console.log('Bolo config layout')
  console.log('  user home :', getBoloHomeDir())
  console.log('  project   :', getProjectBoloDir(cwd))
  console.log('  env override: BOLO_CONFIG_DIR')
  if (user.created.length) {
    console.log('  created (user):')
    for (const f of user.created) console.log('   +', f)
  }
  if (project.created.length) {
    console.log('  created (project):')
    for (const f of project.created) console.log('   +', f)
  }
  if (!user.created.length && !project.created.length) {
    console.log('  (all defaults already present)')
  }
  console.log('See docs/CONFIG.md')
  console.log(JSON.stringify(describeLayout().user, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})