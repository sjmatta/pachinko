import type { Rng, RngStreams } from '../core/rng'
import type { JackpotVariant, MachineSpec, Mode } from './spec'

/**
 * The lottery (抽選).
 *
 * This module is the heart of the machine and the reason the architecture is
 * shaped the way it is. On a real pachinko machine the outcome of a spin is
 * decided **at the instant the ball trips the start-pocket sensor** — before a
 * single reel has turned. Everything the player then watches (the spin, the
 * reach, the twenty-second super-reach cinematic) is a dramatisation of a
 * result that was already sealed.
 *
 * So `drawSpin` runs synchronously inside the sensor callback and returns the
 * whole story at once: the outcome, the presentation pattern chosen to be
 * consistent with it, the symbols the reels will land on, and how long the
 * show runs. The renderer receives this and has no access to the RNG. It is
 * physically incapable of changing the result, which is exactly the guarantee
 * a real machine's sealed board provides.
 */

export type SpinOutcome = 'LOSE' | 'JACKPOT'

/**
 * Presentation patterns (演出), ordered by how much they promise.
 *
 * - `NONE`        — three unrelated symbols, the reels stop and that is that.
 * - `NEAR_MISS`   — two match, the third stops one position off. The cruellest
 *                   loss on the machine, and deliberately common.
 * - `REACH`       — two match, the third crawls. Ordinary tension.
 * - `SUPER_REACH` — the long cinematic. Rare, and carries most of the win rate.
 */
export type ReachPattern = 'NONE' | 'NEAR_MISS' | 'REACH' | 'SUPER_REACH'

export interface SpinDraw {
	outcome: SpinOutcome
	pattern: ReachPattern
	/** Final resting symbol of each of the three reels. */
	reels: [number, number, number]
	durationMs: number
	/** Only present when `outcome === 'JACKPOT'`. */
	variant?: JackpotVariant
}

/**
 * Pattern weights given the outcome is already known.
 *
 * Read these as "how the machine chooses to tell the story". Losses are mostly
 * told flatly; wins are almost always dressed up. The ratio between the two
 * tables is what sets each pattern's apparent trustworthiness — with these
 * numbers a super reach on a 1/99 machine converts about a quarter of the
 * time, which is in the band real machines advertise.
 */
const LOSE_PATTERNS = [
	{ weight: 0.82, value: 'NONE' as const },
	{ weight: 0.05, value: 'NEAR_MISS' as const },
	{ weight: 0.11, value: 'REACH' as const },
	{ weight: 0.02, value: 'SUPER_REACH' as const },
]

const WIN_PATTERNS = [
	{ weight: 0.35, value: 'REACH' as const },
	{ weight: 0.65, value: 'SUPER_REACH' as const },
]

const durationFor = (spec: MachineSpec, pattern: ReachPattern): number =>
	pattern === 'NONE'
		? spec.spinMs.none
		: pattern === 'NEAR_MISS'
			? spec.spinMs.nearMiss
			: pattern === 'REACH'
				? spec.spinMs.reach
				: spec.spinMs.superReach

/** Pick the three symbols that are consistent with a decided outcome. */
function reelsFor(rng: Rng, spec: MachineSpec, outcome: SpinOutcome, pattern: ReachPattern) {
	const n = spec.symbolCount
	if (outcome === 'JACKPOT') {
		const s = rng.int(n)
		return [s, s, s] as [number, number, number]
	}
	if (pattern === 'NONE') {
		// Guarantee the first two differ, or it would read as a reach.
		const a = rng.int(n)
		const b = (a + 1 + rng.int(n - 1)) % n
		const c = rng.int(n)
		return [a, b, c] as [number, number, number]
	}
	// Every remaining loss pattern is a reach: first two match, third does not.
	const a = rng.int(n)
	const offset = pattern === 'NEAR_MISS' ? (rng.chance(0.5) ? 1 : n - 1) : 2 + rng.int(n - 3)
	return [a, a, (a + offset) % n] as [number, number, number]
}

/**
 * Draw a spin. Call this the moment a ball enters a start pocket — never later.
 *
 * The three separate streams matter: retuning the reach-pattern weights must
 * not shift a single jackpot in a soak run, or two board revisions can never be
 * compared against each other.
 */
export function drawSpin(rng: RngStreams, spec: MachineSpec, mode: Mode): SpinDraw {
	const odds = mode === 'ST' ? spec.stOdds : spec.normalOdds
	const outcome: SpinOutcome = rng.jackpot.oneIn(odds) ? 'JACKPOT' : 'LOSE'
	const pattern = rng.pattern.pick<ReachPattern>(
		outcome === 'JACKPOT' ? WIN_PATTERNS : LOSE_PATTERNS,
	)
	const reels = reelsFor(rng.symbol, spec, outcome, pattern)
	const draw: SpinDraw = { outcome, pattern, reels, durationMs: durationFor(spec, pattern) }
	if (outcome === 'JACKPOT') {
		draw.variant = rng.pattern.pick(
			spec.jackpotVariants.map((v) => ({ weight: v.weight, value: v })),
		)
	}
	return draw
}

/**
 * The 普通図柄 lottery behind the through-gate. Winning it opens the electric
 * tulip for a moment. In normal mode it barely ever wins, which is why the
 * right side of the board is unplayable until the machine says otherwise.
 */
export function drawGate(rng: RngStreams, spec: MachineSpec, mode: Mode): boolean {
	const odds = mode === 'NORMAL' || mode === 'JACKPOT' ? spec.gateOddsNormal : spec.gateOddsSupport
	return rng.gate.oneIn(odds)
}
