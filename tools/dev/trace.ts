/**
 * Follow one ball through the board and print where it went.
 *
 * The soak harness answers "how often"; this answers "why". When a board
 * revision drops the spin rate to zero, one ball's path finds the wall that was
 * not supposed to be there far faster than any aggregate can.
 *
 *   npx tsx tools/dev/trace.ts 0.35
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BoardFile } from '../../src/board/types'
import { SIM_DT } from '../../src/core/units'
import { Game } from '../../src/game'
import { initPhysics } from '../../src/sim/world'

const here = dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
	const file = JSON.parse(
		readFileSync(resolve(here, '../../boards/standard-light.board.json'), 'utf8'),
	) as BoardFile
	const handle = Number(process.argv[2] ?? '0.23')
	await initPhysics()
	const game = await Game.create(file, Number(process.argv[3] ?? '1'), 1e7)

	// One ball only: launch it, then let go, so nothing else muddies the path.
	game.setHandle(handle, true)
	let tracked = -1
	game.sim.events.on('launched', ({ ballId }) => {
		if (tracked < 0) tracked = ballId
	})
	const hits: string[] = []
	game.sim.events.on('sensor', (h) => {
		if (h.ballId === tracked) hits.push(h.kind)
	})

	const path: string[] = []
	let done = false
	for (let i = 0; i < Math.ceil(25 / SIM_DT) && !done; i++) {
		game.step()
		if (tracked >= 0) game.setHandle(0, false)
		if (i % 24 === 0 && tracked >= 0) {
			const p = game.sim.ballPosition(tracked, 1)
			path.push(p ? `${p.x.toFixed(0)},${p.y.toFixed(0)}` : hits.length ? 'gone' : 'stage')
		}
		done = hits.some((h) => h === 'out' || h === 'foul' || h === 'heso' || h === 'denchu')
	}
	console.log(`handle ${handle}`)
	console.log(`  path: ${path.join(' → ')}`)
	console.log(`  hits: ${hits.join(', ') || '(none — still in play or stuck)'}`)
}

main()
