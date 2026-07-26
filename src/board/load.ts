import { BALL_RADIUS, NAIL_RADIUS } from '../core/units'
import type { BoardFile, NailDef, Vec2 } from './types'

/**
 * A board converted to world units (centimetres). Structurally identical to the
 * authored file — only the numbers change, and only once, here.
 */
export type Board = Omit<BoardFile, 'units'> & { units: 'cm' }

const scaleVec = (v: Vec2): Vec2 => ({ x: v.x / 10, y: v.y / 10 })

export interface BoardIssue {
	severity: 'error' | 'warning'
	message: string
}

/**
 * Sanity checks worth running on every load.
 *
 * The nail-gap rule catches the mistake that actually happens: an 11.0 mm ball
 * cannot pass a gap of 11.0 mm, so a pair of nails a hair too close is a wall,
 * and a wall where the author meant a route is invisible in the JSON and
 * obvious only after a soak run comes back with a spin rate of zero.
 */
export function validateBoard(file: BoardFile): BoardIssue[] {
	const issues: BoardIssue[] = []
	const ballDia = BALL_RADIUS * 20 // world units → mm
	const nailDia = NAIL_RADIUS * 20

	const nails: NailDef[] = file.nails
	for (let i = 0; i < nails.length; i++) {
		for (let j = i + 1; j < nails.length; j++) {
			const a = nails[i]!
			const b = nails[j]!
			const centres = Math.hypot(a.x - b.x, a.y - b.y)
			const surface = centres - ((a.r ?? nailDia / 2) + (b.r ?? nailDia / 2))
			if (surface < 0) {
				issues.push({
					severity: 'error',
					message: `nails ${a.id} and ${b.id} overlap (${surface.toFixed(2)} mm)`,
				})
			} else if (surface > 0 && surface < ballDia + 0.2 && !(a.closed && b.closed)) {
				issues.push({
					severity: 'warning',
					message:
						`nails ${a.id} and ${b.id} are ${surface.toFixed(2)} mm apart — ` +
						`too tight for an ${ballDia.toFixed(1)} mm ball, so this reads as a wall`,
				})
			}
		}
	}

	const kinds = new Set(file.sensors.map((s) => s.kind))
	for (const required of ['heso', 'out'] as const) {
		if (!kinds.has(required)) {
			issues.push({ severity: 'error', message: `board has no '${required}' sensor` })
		}
	}

	// Nothing but the foul return may sit in the launch channel. Everything
	// that reaches the playfield passes through the channel first, so a pocket
	// authored there catches every ball ever fired — and the resulting numbers
	// look like a nail problem rather than a placement problem.
	const ch = file.channel
	for (const s of file.sensors) {
		if (s.kind === 'foul') continue
		if (!inChannel(ch, s.x, s.y)) continue
		issues.push({
			severity: 'error',
			message: `sensor '${s.id}' (${s.x}, ${s.y}) sits inside the launch channel`,
		})
	}
	return issues
}

function inChannel(ch: BoardFile['channel'], x: number, y: number): boolean {
	const r = Math.hypot(x - ch.centre.x, y - ch.centre.y)
	if (r < ch.innerRadius || r > ch.outerRadius) return false
	let deg = (Math.atan2(y - ch.centre.y, x - ch.centre.x) * 180) / Math.PI
	if (deg < 0) deg += 360
	const lo = Math.min(ch.startDeg, ch.endDeg)
	const hi = Math.max(ch.startDeg, ch.endDeg)
	return deg >= lo && deg <= hi
}

/** Convert an authored board from millimetres into world units. */
export function loadBoard(file: BoardFile): Board {
	const s = (v: number) => v / 10
	return {
		...file,
		units: 'cm',
		field: { centre: scaleVec(file.field.centre), radius: s(file.field.radius) },
		channel: {
			...file.channel,
			centre: scaleVec(file.channel.centre),
			innerRadius: s(file.channel.innerRadius),
			outerRadius: s(file.channel.outerRadius),
		},
		physics: {
			...file.physics,
			nailContactNoise: s(file.physics.nailContactNoise),
			launch: {
				...file.physics.launch,
				muzzle: scaleVec(file.physics.launch.muzzle),
				minSpeed: s(file.physics.launch.minSpeed),
				maxSpeed: s(file.physics.launch.maxSpeed),
				jitterSigma: s(file.physics.launch.jitterSigma),
			},
		},
		walls: file.walls.map((w) => ({ ...w, points: w.points.map(scaleVec) })),
		arcs: file.arcs.map((a) => ({ ...a, centre: scaleVec(a.centre), radius: s(a.radius) })),
		nails: file.nails.map((n) => ({
			...n,
			x: s(n.x),
			y: s(n.y),
			...(n.r === undefined ? {} : { r: s(n.r) }),
		})),
		windmills: file.windmills.map((w) => ({
			...w,
			x: s(w.x),
			y: s(w.y),
			tipRadius: s(w.tipRadius),
			bladeWidth: s(w.bladeWidth),
		})),
		sensors: file.sensors.map((d) => ({
			...d,
			x: s(d.x),
			y: s(d.y),
			w: s(d.w),
			h: s(d.h),
			...(d.maxSpeed === undefined ? {} : { maxSpeed: s(d.maxSpeed) }),
		})),
		movers: file.movers.map((m) => ({
			...m,
			x: s(m.x),
			y: s(m.y),
			halfW: s(m.halfW),
			halfH: s(m.halfH),
			...(m.closedOffset ? { closedOffset: scaleVec(m.closedOffset) } : {}),
			...(m.openOffset ? { openOffset: scaleVec(m.openOffset) } : {}),
		})),
		stage: {
			...file.stage,
			profile: file.stage.profile.map((p) => ({ s: s(p.s), h: s(p.h) })),
			centreSlot: {
				s: s(file.stage.centreSlot.s),
				width: s(file.stage.centreSlot.width),
				maxSpeed: s(file.stage.centreSlot.maxSpeed),
			},
			chuteExit: {
				x: s(file.stage.chuteExit.x),
				y: s(file.stage.chuteExit.y),
				vx: s(file.stage.chuteExit.vx),
				vy: s(file.stage.chuteExit.vy),
			},
			sideExits: file.stage.sideExits.map((e) => ({
				s: s(e.s),
				x: s(e.x),
				y: s(e.y),
				vx: s(e.vx),
				vy: s(e.vy),
			})),
			noiseSigma: s(file.stage.noiseSigma),
		},
	}
}
