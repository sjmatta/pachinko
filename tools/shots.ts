/**
 * Drive the real game in a headless browser and screenshot it.
 *
 * Unit tests cover the machine's logic and the soak harness covers its balance,
 * but neither of them ever renders a frame. This does: it loads the actual
 * page, plays it, forces the machine through the states that are rare enough to
 * be awkward to catch by hand, and writes out pictures. A renderer that throws
 * on the first frame passes every other check in the project.
 *
 *   npm run shots
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Game } from '../src/game'
import type { JackpotVariant } from '../src/machine/spec'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(here, '../shots')
const URL = process.env.PACHINKO_URL ?? 'http://127.0.0.1:5173/'

// The container ships a Chromium that may not match Playwright's expected
// revision, so use it directly rather than downloading another one.
const EXECUTABLE = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

async function main(): Promise<void> {
	mkdirSync(OUT, { recursive: true })
	const browser = await chromium.launch({
		executablePath: EXECUTABLE,
		args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
	})
	// Steam Deck's panel, which is the tighter of the two shipping targets.
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

	const errors: string[] = []
	page.on('pageerror', (e) => errors.push(String(e)))
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text())
	})

	await page.goto(URL, { waitUntil: 'load' })
	await page.waitForFunction('window.pachinko !== undefined', null, { timeout: 30_000 })

	const shot = async (name: string) => {
		await page.screenshot({ path: resolve(OUT, `${name}.png`) })
		console.log(`  ${name}.png`)
	}

	// Idle, before a ball has been fired.
	await page.waitForTimeout(600)
	await shot('01-idle')

	// Play: hold the handle and let the board fill.
	await page.keyboard.down('Space')
	await page.waitForTimeout(6000)
	await shot('02-playing')

	// Force each of the states that are too rare to wait for.
	await page.evaluate(() => {
		const { game } = (window as unknown as { pachinko: { game: Game } }).pachinko
		// Clear anything queued and cut short whatever is playing. A real spin
		// can run for twenty-two seconds, so without this the forced draw simply
		// waits its turn and every shot after this point is of normal play.
		game.machine.holds.clear()
		game.machine.phase = 'IDLE'
		game.machine.holds.push(
			{
				outcome: 'JACKPOT',
				pattern: 'SUPER_REACH',
				reels: [4, 4, 4],
				durationMs: 6000,
				variant: game.machine.spec.jackpotVariants.find((v: JackpotVariant) => v.st)!,
			},
			1,
		)
	})
	await page.waitForTimeout(4000)
	await shot('03-super-reach')

	await page.waitForTimeout(7500)
	await shot('04-jackpot')

	// Feed the attacker so the round counter advances on screen.
	await page.evaluate(() => {
		const { game } = (window as unknown as { pachinko: { game: Game } }).pachinko
		for (let i = 0; i < 9; i++)
			game.machine.onSensor({ kind: 'attacker', id: 'attacker', ballId: i })
	})
	await page.waitForTimeout(1500)
	await shot('05-round')

	await page.evaluate(() => {
		const { game } = (window as unknown as { pachinko: { game: Game } }).pachinko
		game.machine.stRemaining = 60
		game.machine.phase = 'IDLE'
	})
	await page.waitForTimeout(1200)
	await shot('06-st')

	await page.keyboard.up('Space')
	await browser.close()

	if (errors.length) {
		console.error(`\n${errors.length} console/page errors:`)
		for (const e of errors.slice(0, 10)) console.error(`  ${e}`)
		process.exit(1)
	}
	console.log('\nno page errors')
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
