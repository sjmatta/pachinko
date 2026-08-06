/**
 * Where do balls get stuck?
 *
 * A count of reaped balls tells you the board has a hole in it; it does not
 * tell you where. This runs a session and bins every reap against *named*
 * geometry — the windmill discs, the rail annulus, the nearest nail — because
 * "38 balls died inside windmillL" is a thing you can go and fix, and
 * "x=-12 y=24" is not.
 *
 *   npx tsx tools/dev/probe.ts [seconds]
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBoard } from '../../src/board/load'
import type { BoardFile } from '../../src/board/types'
import { SIM_DT } from '../../src/core/units'
import { Game } from '../../src/game'
import { initPhysics } from '../../src/sim/world'

const here = dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
	const file = JSON.parse(
		readFileSync(resolve(here, '../../boards/standard-light.board.json'), 'utf8'),
	) as BoardFile
	const board = loadBoard(file)
	const seconds = Number(process.argv[2] ?? '500')

	await initPhysics()
	const game = await Game.create(file, 21, 1e7)
	for (let i = 0; i < Math.ceil(seconds / SIM_DT); i++) {
		game.setHandle(game.machine.hitSide === 'RIGHT' ? 0.85 : 0.23, true)
		game.step()
	}

	const c = board.channel.centre
	const label = (p: { x: number; y: number }): string => {
		for (const w of board.windmills) {
			if (Math.hypot(w.x - p.x, w.y - p.y) < w.tipRadius + 0.6) return `windmill ${w.id}`
		}
		const r = Math.hypot(p.x - c.x, p.y - c.y)
		let deg = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI
		if (deg < 0) deg += 360
		// Inside the annulus it is the launch channel or the right lane; the
		// angle says which, and either way the rails are what it is against.
		const zone = r > board.channel.innerRadius - 0.6 ? 'annulus' : 'field'
		let near = '—'
		let best = Number.POSITIVE_INFINITY
		for (const n of board.nails) {
			const d = Math.hypot(n.x - p.x, n.y - p.y)
			if (d < best) {
				best = d
				near = n.id
			}
		}
		return `${zone} r=${r.toFixed(1)} ${deg.toFixed(0)}° near ${near}@${best.toFixed(2)}`
	}

	const hist = new Map<string, { n: number; wedged: number }>()
	for (const p of game.sim.stuckSpots) {
		const k = label(p)
		const e = hist.get(k) ?? { n: 0, wedged: 0 }
		e.n++
		if (p.wedged) e.wedged++
		hist.set(k, e)
	}

	const s = game.sim
	console.log(
		`stuck ${s.stuckReaped} / ${game.stats.launched} launched ` +
			`(${s.stuckWedged} wedged, ${s.stuckAgedOut} aged out)`,
	)
	console.log(
		[...hist.entries()]
			.sort((a, b) => b[1].n - a[1].n)
			.slice(0, 15)
			.map(([k, e]) => `${String(e.n).padStart(4)}  ${e.wedged === e.n ? 'W' : ' '}  ${k}`)
			.join('\n'),
	)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
