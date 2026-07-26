/**
 * The machine specification (スペック).
 *
 * On a real machine this is the sealed ROM: probabilities, round structure and
 * per-pocket payouts, certified and unchangeable. Here it is plain data loaded
 * from the board JSON, so a new machine is a new data file rather than new
 * code.
 */

/** Which side of the board the player should be aiming at. */
export type HitSide = 'LEFT' | 'RIGHT'

/**
 * Machine modes.
 *
 * - `NORMAL`  通常   — left-hit, base probability, no electric-tulip support.
 * - `JACKPOT` 大当り — right-hit, the attacker opens for a fixed set of rounds.
 * - `ST`      ST     — right-hit, raised probability for a fixed number of
 *                      spins. This is what produces the "chain" of jackpots
 *                      that defines a modern machine's payout curve.
 * - `JITAN`   時短   — right-hit, base probability but generous electric-tulip
 *                      support, so spins cost almost no balls.
 */
export type Mode = 'NORMAL' | 'JACKPOT' | 'ST' | 'JITAN'

export interface Payouts {
	/** ヘソ — centre start pocket. */
	heso: number
	/** 電チュー — electric tulip, the right-side start pocket. */
	denchu: number
	/** アタッカー — the big winning pocket that opens during rounds. */
	attacker: number
	/** 一般入賞口 — the small side pockets that pay but do not spin. */
	sidePocket: number
}

/**
 * One possible jackpot result. Real machines roll a table here: the same
 * "you won" can mean 3 rounds and straight back to normal, or 10 rounds
 * followed by ST. This uncertainty is a large part of the tension.
 */
export interface JackpotVariant {
	id: string
	label: string
	weight: number
	rounds: number
	/** Enter ST after the rounds finish. */
	st: boolean
	/** Spins of ST granted (ignored unless `st`). */
	stSpins: number
	/** Spins of 時短 granted after ST expires, or after a non-ST jackpot. */
	jitanSpins: number
}

export interface MachineSpec {
	id: string
	name: string

	/** Base jackpot odds, as the denominator of 1/N. */
	normalOdds: number
	/** Jackpot odds during ST. */
	stOdds: number

	/** 普通図柄 — the through-gate lottery that opens the electric tulip. */
	gateOddsNormal: number
	gateOddsSupport: number

	jackpotVariants: JackpotVariant[]

	/** Balls that must enter the attacker to end a round early. */
	ballsPerRound: number
	/** Round also ends on this timeout, as on a real machine. */
	roundTimeoutMs: number
	/** Attacker close/open dwell between rounds. */
	roundIntervalMs: number

	payouts: Payouts

	/** 保留 — how many spins can be banked while one is playing. */
	holdCapacity: number
	gateHoldCapacity: number

	/** How long the electric tulip stays open per gate win, by mode. */
	denchuOpenMsNormal: number
	denchuOpenMsSupport: number

	/** Reel presentation durations, by pattern. */
	spinMs: {
		none: number
		nearMiss: number
		reach: number
		superReach: number
	}

	/** Number of distinct reel symbols (0..symbolCount-1). */
	symbolCount: number
}

export const hitSideFor = (mode: Mode): HitSide => (mode === 'NORMAL' ? 'LEFT' : 'RIGHT')

/** ST and 時短 both give electric-tulip support; NORMAL and JACKPOT do not. */
export const hasSupport = (mode: Mode): boolean => mode === 'ST' || mode === 'JITAN'
