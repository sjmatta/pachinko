/**
 * Draw the board — geometry, sensors and sampled ball paths — as an SVG.
 *
 * Nail placement is a spatial problem and reading it back out of aggregate
 * counters is guesswork. Being able to look at the board, with a few hundred
 * ball tracks drawn over it, turns "the start pocket gets nothing" from a
 * mystery into something you can point at.
 *
 *   npx tsx tools/dev/board-svg.ts 0.4 > board.svg
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBoard } from '../../src/board/load'
import type { BoardFile } from '../../src/board/types'
import { BALL_RADIUS, NAIL_RADIUS, SIM_DT } from '../../src/core/units'
import { Game } from '../../src/game'
import { initPhysics } from '../../src/sim/world'

const here = dirname(fileURLToPath(import.meta.url))
const SCALE = 10 // svg px per world unit (cm)
const rad = (d: number) => (d * Math.PI) / 180

const KIND_COLOUR: Record<string, string> = {
	heso: '#ff3b6b',
	denchu: '#ffb02e',
	attacker: '#38d977',
	sidePocket: '#7f8cff',
	gate: '#39c6ff',
	warp: '#c86bff',
	out: '#556',
	foul: '#864',
}

async function main(): Promise<void> {
	const file = JSON.parse(
		readFileSync(resolve(here, '../../boards/standard-light.board.json'), 'utf8'),
	) as BoardFile
	const board = loadBoard(file)
	const handle = Number(process.argv[2] ?? '0.4')
	const tracks = Number(process.argv[3] ?? '60')

	await initPhysics()
	const game = await Game.create(file, 11, 1e7)
	game.setHandle(handle, true)

	// Record every active ball's path, so the drawing shows where balls
	// actually go rather than where the layout suggests they should.
	const paths = new Map<number, string[]>()
	const done: string[][] = []
	game.sim.events.on('launched', ({ ballId }) => paths.set(ballId, []))
	game.sim.events.on('sensor', ({ ballId, kind }) => {
		if (kind === 'gate') return
		const p = paths.get(ballId)
		if (p && p.length > 2) done.push(p)
		paths.delete(ballId)
	})

	let i = 0
	while (done.length < tracks && i < Math.ceil(240 / SIM_DT)) {
		game.step()
		if (i % 3 === 0) {
			for (const [id, pts] of paths) {
				const p = game.sim.ballPosition(id, 1)
				if (p) pts.push(`${p.x.toFixed(2)},${p.y.toFixed(2)}`)
			}
		}
		i++
	}

	// Optional zoom window: `npx tsx board-svg.ts 0.4 80 0 14 12` centres the
	// drawing on (0, 14) with a half-width of 12 world units.
	const zx = process.argv[4] === undefined ? null : Number(process.argv[4])
	const zy = Number(process.argv[5] ?? 0)
	const zr = Number(process.argv[6] ?? 12)

	const R = board.channel.outerRadius + 3
	const cx = zx ?? board.channel.centre.x
	const cy = zx === null ? board.channel.centre.y : zy
	const half = zx === null ? R : zr
	const minX = cx - half
	const maxX = cx + half
	const maxY = cy + half
	const scale = zx === null ? SCALE : (SCALE * R) / half
	const w = (maxX - minX) * scale
	const h = 2 * half * scale
	// SVG y grows downward; the board's does not.
	const X = (x: number) => ((x - minX) * scale).toFixed(1)
	const Y = (y: number) => ((maxY - y) * scale).toFixed(1)
	const SC = scale

	const out: string[] = []
	out.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
		`<rect width="${w}" height="${h}" fill="#0d0f14"/>`,
	)

	for (const arc of board.arcs) {
		const pts: string[] = []
		const span = arc.endDeg - arc.startDeg
		for (let s = 0; s <= arc.segments; s++) {
			const deg = arc.startDeg + (span * s) / arc.segments
			pts.push(
				`${X(arc.centre.x + arc.radius * Math.cos(rad(deg)))},${Y(arc.centre.y + arc.radius * Math.sin(rad(deg)))}`,
			)
		}
		out.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#4a5568" stroke-width="2"/>`)
	}
	for (const wall of board.walls) {
		const pts = wall.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')
		out.push(`<polyline points="${pts}" fill="none" stroke="#7b8494" stroke-width="2.5"/>`)
	}

	for (const track of done) {
		out.push(
			`<polyline points="${track
				.map((p) => {
					const [a, b] = p.split(',')
					return `${X(+a!)},${Y(+b!)}`
				})
				.join(' ')}" fill="none" stroke="#ffd15c" stroke-width="0.7" opacity="0.32"/>`,
		)
	}

	for (const n of board.nails) {
		out.push(
			`<circle cx="${X(n.x)}" cy="${Y(n.y)}" r="${(n.r ?? NAIL_RADIUS) * SC}" fill="#cfd6e4"/>`,
		)
	}
	for (const wm of board.windmills) {
		out.push(
			`<circle cx="${X(wm.x)}" cy="${Y(wm.y)}" r="${wm.tipRadius * SC}" fill="none" stroke="#8899aa" stroke-width="1.5"/>`,
		)
	}
	for (const s of board.sensors) {
		const c = KIND_COLOUR[s.kind] ?? '#fff'
		out.push(
			`<rect x="${X(s.x - s.w / 2)}" y="${Y(s.y + s.h / 2)}" width="${(s.w * SC).toFixed(1)}" height="${(s.h * SC).toFixed(1)}" fill="${c}" opacity="0.5" stroke="${c}" stroke-width="1"/>`,
			`<text x="${X(s.x)}" y="${Y(s.y)}" fill="${c}" font-size="11" font-family="monospace" text-anchor="middle">${s.id}</text>`,
		)
	}
	const m = board.physics.launch.muzzle
	out.push(
		`<circle cx="${X(m.x)}" cy="${Y(m.y)}" r="${BALL_RADIUS * SC}" fill="#ff5555"/>`,
		`<text x="12" y="22" fill="#8fa" font-size="16" font-family="monospace">handle ${handle} — ${done.length} tracks</text>`,
		'</svg>',
	)

	const dest = resolve(here, '../../board.svg')
	writeFileSync(dest, out.join('\n'))
	console.log(dest)
}

main()
