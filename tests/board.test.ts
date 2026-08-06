import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { validateBoard } from '../src/board/load'
import type { BoardFile } from '../src/board/types'
import { SIM_DT } from '../src/core/units'
import { Game } from '../src/game'
import { initPhysics } from '../src/sim/world'

const here = dirname(fileURLToPath(import.meta.url))
const board = JSON.parse(
	readFileSync(resolve(here, '../boards/standard-light.board.json'), 'utf8'),
) as BoardFile

/**
 * These are slower than the rest of the suite because they run real physics,
 * and they earn it. The first reference board lost roughly a quarter of every
 * ball fired at it to geometry that traps balls, and not one of the existing
 * tests noticed: the machine logic was perfectly correct about a board that
 * quietly ate its own ammunition. The only way to catch that is to fire balls.
 */
describe('reference board', () => {
	it('has no geometry errors', () => {
		const issues = validateBoard(board)
		expect(issues.filter((i) => i.severity === 'error')).toEqual([])
	})

	/**
	 * Warnings are listed rather than merely counted so that a new one shows up
	 * as a diff in this file — which forces a decision about it — instead of
	 * being absorbed into a threshold nobody revisits.
	 */
	it('has only the warnings we have already looked at', () => {
		const warnings = validateBoard(board)
			.filter((i) => i.severity === 'warning')
			.map((i) => i.message)
		// The gathering ramp is a deliberate wall of nails set closer together
		// than a ball is wide, so the pair-spacing rule flags where it passes
		// close to something else. That is the ramp doing its job.
		expect(warnings.every((w) => w.includes('reads as a wall'))).toBe(true)
		expect(warnings.length).toBeLessThanOrEqual(2)
	})

	// One session, several assertions. Ten minutes of simulated play costs real
	// seconds, and running it once per expectation would put the suite over a
	// minute for no extra information.
	let session: Awaited<ReturnType<typeof play>>
	beforeAll(async () => {
		session = await play(600)
	}, 120_000)

	it('does not wedge balls', () => {
		const { stuck, launched } = session
		expect(launched).toBeGreaterThan(500)
		// A backstop that fires is a board with a hole in it. The bar is well
		// under one percent because the honest figure is zero, and anything that
		// creeps in above this is a trap somewhere that wants finding with
		// `npx tsx tools/dev/probe.ts`.
		expect(stuck / launched).toBeLessThan(0.01)
	})

	it('feeds the start pocket at roughly the rate a real machine does', () => {
		const { hesoEntries, launched } = session
		const rate = hesoEntries / launched
		// Real machines land near one ball in fifteen. The band is wide because
		// this is the number every nail on the board contributes to, and it is
		// meant to move when the board is tuned — it is here to catch a board
		// that has stopped feeding the pocket at all, not to freeze the tuning.
		expect(rate).toBeGreaterThan(1 / 40)
		expect(rate).toBeLessThan(1 / 8)
	})
})

async function play(seconds: number) {
	await initPhysics()
	const game = await Game.create(board, 21, 1e7)
	for (let i = 0; i < Math.ceil(seconds / SIM_DT); i++) {
		// Play the side the machine tells you to, exactly as the soak harness
		// does; a fixed handle measures a player ignoring the 右打ち sign.
		game.setHandle(game.machine.hitSide === 'RIGHT' ? 0.85 : 0.23, true)
		game.step()
	}
	return {
		stuck: game.sim.stuckReaped,
		launched: game.stats.launched,
		hesoEntries: game.stats.hesoEntries,
	}
}
