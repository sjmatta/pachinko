/**
 * Seeded xoshiro128** PRNG.
 *
 * A real machine draws from a hardware counter that free-runs at high
 * frequency and is sampled the instant a ball trips the start-pocket sensor.
 * We can't have hardware, but we can have the property that matters: the draw
 * is a pure function of state, taken at sensor time, and reproducible. A
 * seeded, serialisable generator means any session can be replayed exactly,
 * which is what makes the soak harness and the unit tests trustworthy.
 */

export type RngState = readonly [number, number, number, number]

const rotl = (x: number, k: number): number => (x << k) | (x >>> (32 - k))

export class Rng {
	private s0: number
	private s1: number
	private s2: number
	private s3: number

	constructor(seed: number | RngState = 1) {
		if (typeof seed === 'number') {
			// splitmix32 to spread a single integer seed across all four words.
			let z = seed >>> 0
			const next = (): number => {
				z = (z + 0x9e3779b9) >>> 0
				let t = z
				t = Math.imul(t ^ (t >>> 16), 0x21f0aaad)
				t = Math.imul(t ^ (t >>> 15), 0x735a2d97)
				return (t ^ (t >>> 15)) >>> 0
			}
			this.s0 = next()
			this.s1 = next()
			this.s2 = next()
			this.s3 = next()
			// All-zero state is a fixed point; nudge it.
			if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1
		} else {
			;[this.s0, this.s1, this.s2, this.s3] = seed as [number, number, number, number]
		}
	}

	/** Raw 32-bit output. */
	nextUint32(): number {
		const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7) >>> 0, 9) >>> 0
		const t = (this.s1 << 9) >>> 0
		this.s2 ^= this.s0
		this.s3 ^= this.s1
		this.s1 ^= this.s2
		this.s0 ^= this.s3
		this.s2 ^= t
		this.s3 = rotl(this.s3, 11) >>> 0
		this.s0 >>>= 0
		this.s1 >>>= 0
		this.s2 >>>= 0
		this.s3 >>>= 0
		return result
	}

	/** Uniform in [0, 1). */
	next(): number {
		return this.nextUint32() / 0x1_0000_0000
	}

	/** Uniform integer in [0, n). */
	int(n: number): number {
		return Math.floor(this.next() * n)
	}

	/** Uniform float in [lo, hi). */
	range(lo: number, hi: number): number {
		return lo + this.next() * (hi - lo)
	}

	/** True with probability `p`. */
	chance(p: number): boolean {
		return this.next() < p
	}

	/**
	 * A 1-in-`denominator` hit, expressed the way pachinko specs are written
	 * ("1/99.9"). Uses an integer comparison against a scaled counter so the
	 * odds are exact rather than subject to float drift.
	 */
	oneIn(denominator: number): boolean {
		return this.int(Math.round(denominator * 10)) < 10
	}

	/** Pick an entry from a weighted table. */
	pick<T>(entries: readonly { weight: number; value: T }[]): T {
		let total = 0
		for (const e of entries) total += e.weight
		let roll = this.next() * total
		for (const e of entries) {
			roll -= e.weight
			if (roll < 0) return e.value
		}
		return entries[entries.length - 1]!.value
	}

	/** Standard normal deviate (Box-Muller, one of the pair). */
	gaussian(mean = 0, sigma = 1): number {
		const u = 1 - this.next()
		const v = this.next()
		return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
	}

	getState(): RngState {
		return [this.s0, this.s1, this.s2, this.s3]
	}

	setState(state: RngState): void {
		;[this.s0, this.s1, this.s2, this.s3] = state as [number, number, number, number]
	}
}

/**
 * Independent generators derived from one master seed.
 *
 * Keeping these separate is not fussiness — it is what makes A/B tuning valid.
 * If launch jitter and jackpot draws shared a stream, nudging the jitter sigma
 * would reshuffle every jackpot in a soak run and two board revisions could
 * never be compared. With separate streams, changing how a ball wobbles off a
 * nail leaves the lottery sequence untouched.
 */
export type StreamName = 'jackpot' | 'symbol' | 'pattern' | 'gate' | 'launch' | 'contact' | 'stage'

const STREAMS: StreamName[] = ['jackpot', 'symbol', 'pattern', 'gate', 'launch', 'contact', 'stage']

export type RngStreams = Record<StreamName, Rng>

export function createStreams(masterSeed: number): RngStreams {
	const out = {} as RngStreams
	STREAMS.forEach((name, i) => {
		// Offset each stream far apart in splitmix space so their initial
		// states are unrelated.
		out[name] = new Rng((masterSeed + i * 0x9e37_79b9) >>> 0)
	})
	return out
}
