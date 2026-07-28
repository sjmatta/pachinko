/**
 * Board geometry rules that more than one layer needs.
 *
 * These are unit-agnostic on purpose — the generator authors in millimetres,
 * the validator checks millimetres, and the physics builder works in
 * centimetres. Passing the ball diameter in keeps one implementation of each
 * rule instead of three that can drift apart.
 */

import type { Vec2 } from './types'

/**
 * How far from a wall a nail has to stand before the corner between them is too
 * shallow to hold a ball. See `trapsAgainstWall`.
 */
export const TRAP_GAP_HI_RATIO = 1.25
/** A nail this close to a wall is *on* it, and leaves no corner to sit in. */
export const FLUSH_MAX = 1.0

/**
 * Does a nail this far from a wall trap balls against it?
 *
 * The instinct is to look for a slot slightly wider than a ball, and that is
 * the wrong shape. Measurement says otherwise: on the first reference board,
 * balls were found wedged at nail-to-wall gaps of 6.8, 8.6 and 9.3 mm — every
 * one of them comfortably *narrower* than the 11 mm ball that was stuck in it.
 *
 * What catches the ball is not the width of the gap, it is the corner. A nail
 * standing a few millimetres off a wall makes a V that converges downward, the
 * ball rolls in from above, touches both surfaces, and there is no longer
 * anything that can push it out. Gravity is holding it in place.
 *
 * So the rule is flush or clear. A nail *on* a wall leaves no corner to sit in;
 * a nail more than a ball and a quarter away leaves a corner too shallow to
 * hold one. Everything between is where balls go to die.
 */
export function trapsAgainstWall(gap: number, ballDia: number): boolean {
	return gap > FLUSH_MAX && gap < ballDia * TRAP_GAP_HI_RATIO
}

/**
 * Clearance a nail needs from a windmill's swept circle.
 *
 * Wider than the plain trap band, because the far side of this gap is moving.
 * A static slot narrower than a ball is a wall the ball bounces off; the same
 * slot with a blade sweeping into it is a press, and it will find a ball that a
 * static version would have turned away.
 */
export function windmillNailClearance(tipRadius: number, nailRadius: number, ballDia: number) {
	return tipRadius + nailRadius + ballDia * WINDMILL_CLEARANCE_RATIO
}

/**
 * Measured, not chosen. At 1.25 — the plain trap-band ratio — a nail 14.0 mm
 * off the blade tips still ate balls steadily, because the gap a blade presents
 * is not the static one: the vane sweeps through and the clearance is only that
 * wide for part of the turn. 1.5 leaves room for the moving half.
 */
export const WINDMILL_CLEARANCE_RATIO = 1.5

/**
 * The clear gap between two adjacent vanes, measured at the tips where it is
 * widest.
 */
export function vaneGapAtTip(w: { blades: number; bladeWidth: number; tipRadius: number }): number {
	return (2 * Math.PI * w.tipRadius) / w.blades - w.bladeWidth
}

/**
 * Can a ball get in between a windmill's vanes?
 *
 * There are only two safe windmills, and it is worth being explicit about which
 * one this is. Either every gap between the vanes is wider than a ball all the
 * way in to the axis — which no real wheel is, because the gaps close as they
 * approach the centre — or every gap is narrower than a ball, so the ball rides
 * across the tips and never enters at all.
 *
 * A real 風車 is the second kind: a compact wheel, small enough relative to an
 * 11 mm ball that it flicks the ball sideways rather than catching it. Building
 * the first kind was tried here and produced a bucket wheel — a ball dropped
 * into a pocket between two vanes rides round and never leaves.
 */
export function windmillAdmitsBall(
	w: { blades: number; bladeWidth: number; tipRadius: number },
	ballDia: number,
): boolean {
	return vaneGapAtTip(w) > ballDia * 0.85
}

/** The disc the vanes stand on. Structural — the tip gap is the safety rule. */
export function hubRadiusOf(w: { tipRadius: number; hubRadius?: number }): number {
	return w.hubRadius ?? w.tipRadius * 0.45
}

/** Distance from a point to a line segment. */
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
	const dx = b.x - a.x
	const dy = b.y - a.y
	const lenSq = dx * dx + dy * dy
	if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Distance from a point to a polyline, or Infinity if it has no segments. */
export function distanceToPolyline(p: Vec2, points: readonly Vec2[]): number {
	let best = Number.POSITIVE_INFINITY
	for (let i = 0; i + 1 < points.length; i++) {
		best = Math.min(best, distanceToSegment(p, points[i]!, points[i + 1]!))
	}
	return best
}

/**
 * Distance from a point to an arc, measured to the arc itself rather than to
 * the whole circle: a nail well inside the disc is nowhere near a rail that only
 * spans the top of it.
 */
export function distanceToArc(
	p: Vec2,
	arc: { centre: Vec2; radius: number; startDeg: number; endDeg: number },
): number {
	const dx = p.x - arc.centre.x
	const dy = p.y - arc.centre.y
	const r = Math.hypot(dx, dy)
	let deg = (Math.atan2(dy, dx) * 180) / Math.PI
	const lo = Math.min(arc.startDeg, arc.endDeg)
	const hi = Math.max(arc.startDeg, arc.endDeg)
	// Arcs are authored with either endpoint able to exceed 360°, so bring the
	// bearing into the same turn before comparing.
	while (deg < lo) deg += 360
	if (deg <= hi) return Math.abs(r - arc.radius)
	const end = (d: number): Vec2 => ({
		x: arc.centre.x + arc.radius * Math.cos((d * Math.PI) / 180),
		y: arc.centre.y + arc.radius * Math.sin((d * Math.PI) / 180),
	})
	const a = end(lo)
	const b = end(hi)
	return Math.min(Math.hypot(p.x - a.x, p.y - a.y), Math.hypot(p.x - b.x, p.y - b.y))
}
