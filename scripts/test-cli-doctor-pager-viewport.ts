/**
 * OI-16: embedded Doctor pager must not consume the terminal viewport.
 */
import {
  measureTerminalText,
} from '../packages/cli/src/index.ts'
import { RetainedOverlayHost } from '../packages/cli/src/tui/retainedOverlay.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

const doctorContent = Array.from(
  { length: 29 },
  (_, index) => `diagnostic row ${index + 1}: ready`,
).join('\n')

function createHost(rows: number) {
  const inputStates: boolean[] = []
  const overlayStates: string[] = []
  const hiddenStates: boolean[] = []
  const host = new RetainedOverlayHost({
    color: false,
    setOverlayState: (overlay) => {
      overlayStates.push(overlay.mode)
    },
    requestRender: () => {},
    setInputEnabled: (active) => {
      inputStates.push(active)
    },
    shouldKeepInput: () => true,
    getColumns: () => 120,
    getRows: () => rows,
  })
  host.attach({
    setHidden(value: boolean) {
      hiddenStates.push(value)
    },
  } as never)
  return { host, inputStates, overlayStates, hiddenStates }
}

async function testDoctorViewport(rows: number): Promise<void> {
  const fixture = createHost(rows)
  const result = fixture.host.runTextPager({
    key: 'slash:doctor',
    title: 'Doctor',
    content: doctorContent,
  })
  const firstPage = fixture.host.render(120)
  assert(
    firstPage.length <= 21,
    `${rows}-row terminal caps embedded Doctor pager at 18 body rows plus chrome; got ${firstPage.length}`,
  )
  assert(
    firstPage.at(-1)?.includes('q/Esc close'),
    `${rows}-row terminal keeps the pager close hint visible`,
  )
  assert(
    firstPage.at(-1)?.includes('1/2'),
    `${rows}-row terminal splits the 29-line Doctor report into two pages`,
  )
  assert(
    firstPage.every((line) => measureTerminalText(line) <= 120),
    `${rows}-row Doctor pager fits the terminal width`,
  )

  fixture.host.handleInput('\u001b[B')
  const secondPage = fixture.host.render(120)
  assert(
    secondPage.at(-1)?.includes('2/2') &&
      secondPage.some((line) => line.includes('diagnostic row 29')),
    `${rows}-row terminal can reach the final Doctor page`,
  )

  fixture.host.handleInput('q')
  const closed = await result
  assert(
    closed.reason === 'quit' &&
      !fixture.host.isActive() &&
      fixture.overlayStates.at(-1) === 'none' &&
      fixture.hiddenStates.at(-1) === true &&
      fixture.inputStates.at(-1) === true,
    `${rows}-row Doctor pager closes and restores Composer ownership`,
  )
}

async function testShortPagerDoesNotFillViewport(): Promise<void> {
  const fixture = createHost(80)
  const result = fixture.host.runTextPager({
    key: 'slash:context:details',
    title: 'Context details',
    content: 'single diagnostic line',
  })
  const screen = fixture.host.render(120)
  assert(
    screen.length === 4,
    `single-line text pager uses title, divider, body and footer only; got ${screen.length}`,
  )
  assert(
    screen.at(-1)?.includes('1/1') &&
      screen.at(-1)?.includes('q/Esc close'),
    'single-page footer remains visible',
  )
  fixture.host.handleInput('\u001b')
  assert((await result).reason === 'quit', 'Escape closes the short text pager')
}

for (const rows of [24, 48, 80]) {
  await testDoctorViewport(rows)
}
await testShortPagerDoesNotFillViewport()

console.log('PASS: CLI Doctor pager viewport')
