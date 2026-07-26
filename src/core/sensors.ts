/**
 * The vocabulary shared between the physics simulation and the machine logic.
 *
 * `sim` knows where these are on the board and when a ball touched one; it has
 * no idea what any of them mean. `machine` knows what they mean and has no idea
 * where they are. Both import this file and neither imports the other.
 */

export type SensorKind =
	/** ヘソ — the centre start pocket. Trips the jackpot lottery. */
	| 'heso'
	/** 電チュー — electric tulip, the right-side start pocket. */
	| 'denchu'
	/** アタッカー — the big winning pocket, open only during rounds. */
	| 'attacker'
	/** 一般入賞口 — small side pockets. They pay balls but never spin. */
	| 'sidePocket'
	/** スルー — the through-gate. Pays nothing; runs the tulip lottery. */
	| 'gate'
	/** ワープ — the tube into the centre stage. */
	| 'warp'
	/** アウト口 — the drain at the bottom of the board. */
	| 'out'
	/** ファール — a shot too weak to clear the rail, returned to the tray. */
	| 'foul'

/** Whether a ball is swallowed by the sensor or passes straight through it. */
export const CAPTURES: Record<SensorKind, boolean> = {
	heso: true,
	denchu: true,
	attacker: true,
	sidePocket: true,
	gate: false,
	warp: true,
	out: true,
	foul: true,
}

export interface SensorHit {
	kind: SensorKind
	/** Identifies the specific sensor instance, e.g. `sidePocket.left`. */
	id: string
	ballId: number
}
