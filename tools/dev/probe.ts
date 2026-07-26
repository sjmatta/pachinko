// dev probe: where do balls get stuck?
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BoardFile } from '../../src/board/types'
import { SIM_DT } from '../../src/core/units'
import { Game } from '../../src/game'
import { initPhysics } from '../../src/sim/world'

const here = dirname(fileURLToPath(import.meta.url))
const file = JSON.parse(
	readFileSync(resolve(here, '../../boards/standard-light.board.json'), 'utf8'),
) as BoardFile
await initPhysics()
const g = await Game.create(file, 21, 1e7)
for (let i = 0; i < Math.ceil(500 / SIM_DT); i++) {
	g.setHandle(g.machine.hitSide === 'RIGHT' ? 0.55 : 0.4, true)
	g.step()
}
const hist = new Map<string, number>()
for (const p of g.sim.stuckSpots) {
	const k = `x=${(Math.round(p.x / 2) * 2).toString().padStart(4)} y=${(Math.round(p.y / 2) * 2).toString().padStart(3)}`
	hist.set(k, (hist.get(k) ?? 0) + 1)
}
console.log(`stuck ${g.sim.stuckReaped} / ${g.stats.launched} launched`)
console.log(
	[...hist.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([k, v]) => `${String(v).padStart(3)}  ${k}`)
		.join('\n'),
)
