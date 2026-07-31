/**
 * /theme 命令 + 持久化 + 启动消费测试（无 LLM）：
 * - core dispatch：无参 picker / list / 非法参数 / 直接参数定位
 * - setTuiThemeConfig：写入/读回/幂等/保留既有字段（BOLO_CONFIG_DIR 隔离）
 * - getPersistedTuiThemeSync：启动路径同步读取（缺文件返回 undefined）
 * - 主题解析优先级：显式 theme 参数优先于 env（resumeCli 仅在 env 未设时传持久化值）
 */
import { strict as assert } from 'node:assert'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createSession, dispatchSlashCommand } from '../packages/core/src/index.ts'
import {
  getPersistedTuiTheme,
  getPersistedTuiThemeSync,
  setTuiThemeConfig,
} from '../packages/config/src/index.ts'
import { TUI_THEME_IDS } from '../packages/shared/src/index.ts'
import { resolveTuiTheme } from '../packages/cli/src/tui/theme.ts'

async function main() {
  const session = await createSession({
    cwd: process.cwd(),
    systemPrompt: false,
    permissionMode: 'default',
    model: 'mock-a',
  })

  // ---- /theme 无参 → action-picker ----
  const picker = await dispatchSlashCommand(session, 'theme', '')
  assert.equal(picker.ok, true, 'theme ok')
  assert.equal(picker.overlayView?.kind, 'action-picker', 'theme picker')
  const pickerOverlay =
    picker.overlayView?.kind === 'action-picker' ? picker.overlayView : undefined
  assert.equal(pickerOverlay?.action, 'theme', 'theme action')
  assert.equal(pickerOverlay?.items.length, 5, '5 themes')
  assert.deepEqual(
    pickerOverlay?.items.map((item) => item.id),
    [...TUI_THEME_IDS],
    'theme ids match shared contract',
  )
  assert.equal(pickerOverlay?.initialIndex, 0, 'default initial index')

  // ---- /theme list ----
  const list = await dispatchSlashCommand(session, 'theme', 'list')
  assert.equal(list.ok, true, 'list ok')
  assert.ok(list.message.includes('aurora'), 'list mentions aurora')

  // ---- /theme 非法参数 ----
  const bad = await dispatchSlashCommand(session, 'theme', 'bogus')
  assert.equal(bad.ok, false, 'unknown theme rejected')

  // ---- /theme neon → initialIndex 定位 ----
  const neon = await dispatchSlashCommand(session, 'theme', 'neon')
  const neonOverlay =
    neon.overlayView?.kind === 'action-picker' ? neon.overlayView : undefined
  assert.equal(neonOverlay?.initialIndex, 2, 'neon index 2')

  // ---- 持久化 roundtrip（BOLO_CONFIG_DIR 隔离） ----
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-theme-'))
  const savedConfigDir = process.env.BOLO_CONFIG_DIR
  process.env.BOLO_CONFIG_DIR = tmp
  try {
    const applied = await setTuiThemeConfig({ theme: 'amber' })
    assert.equal(applied.ok, true, 'write ok')
    assert.equal(await getPersistedTuiTheme(), 'amber', 'async read back')
    assert.equal(getPersistedTuiThemeSync(), 'amber', 'sync read back')
    // 幂等
    const again = await setTuiThemeConfig({ theme: 'amber' })
    assert.equal(again.ok, true, 'idempotent ok')
    assert.ok(again.message.includes('already'), 'idempotent message')
    // 保留既有字段
    const raw = JSON.parse(
      await fs.readFile(path.join(tmp, 'config.json'), 'utf8'),
    ) as Record<string, unknown>
    assert.equal(raw.theme, 'amber', 'config.json theme field')
    // 改主题
    await setTuiThemeConfig({ theme: 'neon' })
    assert.equal(getPersistedTuiThemeSync(), 'neon', 'updated theme')
  } finally {
    if (savedConfigDir === undefined) delete process.env.BOLO_CONFIG_DIR
    else process.env.BOLO_CONFIG_DIR = savedConfigDir
    await fs.rm(tmp, { recursive: true, force: true })
  }

  // ---- 无 config 时同步读取返回 undefined（不创建目录） ----
  assert.equal(getPersistedTuiThemeSync({ layout: undefined }), undefined)

  // ---- 解析优先级：显式 theme 参数优先于 env ----
  assert.equal(
    resolveTuiTheme({ theme: 'amber', env: { BOLO_THEME: 'neon' } }).id,
    'amber',
    'explicit theme wins',
  )
  assert.equal(
    resolveTuiTheme({ env: { BOLO_THEME: 'neon' } }).id,
    'neon',
    'env wins when no explicit theme',
  )

  console.log('PASS: theme command + persistence + startup consumption')
}

await main()
