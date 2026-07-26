import type { SpinDraw } from './lottery'

/**
 * 保留 — the hold queue.
 *
 * While one spin is playing out, further start-pocket entries are banked as
 * lamps under the screen. Each lamp is a spin whose outcome has *already been
 * decided* — the machine genuinely knows the future here, which is exactly how
 * real machines can run look-ahead effects that hint at a jackpot two spins
 * before it lands.
 *
 * There are two independent queues. 特図1 is fed by the centre pocket, 特図2 by
 * the electric tulip, and modern machines drain 特図2 first. That priority is
 * not cosmetic: during ST every spin comes from the tulip, so the rule keeps
 * the machine spinning off the right side and lets any leftover centre holds
 * sit untouched until support ends.
 */
export class HoldQueue {
	private q1: SpinDraw[] = []
	private q2: SpinDraw[] = []

	/** Spins that were lost because the queue was already full (保留オーバー). */
	overflow1 = 0
	overflow2 = 0

	constructor(
		private readonly capacity1: number,
		private readonly capacity2: number,
	) {}

	get count1(): number {
		return this.q1.length
	}

	get count2(): number {
		return this.q2.length
	}

	get total(): number {
		return this.q1.length + this.q2.length
	}

	/**
	 * Bank a spin. Returns false if the queue was full — the ball still pays
	 * out, it just buys no lottery, which is a real and often-overlooked way to
	 * waste balls when playing too fast.
	 */
	push(draw: SpinDraw, which: 1 | 2): boolean {
		const q = which === 1 ? this.q1 : this.q2
		const cap = which === 1 ? this.capacity1 : this.capacity2
		if (q.length >= cap) {
			if (which === 1) this.overflow1++
			else this.overflow2++
			return false
		}
		q.push(draw)
		return true
	}

	/** Take the next spin to play, 特図2 first. */
	shift(): { draw: SpinDraw; which: 1 | 2 } | undefined {
		if (this.q2.length > 0) return { draw: this.q2.shift()!, which: 2 }
		if (this.q1.length > 0) return { draw: this.q1.shift()!, which: 1 }
		return undefined
	}

	/** Read-only peek, for look-ahead presentation. */
	peekAll(): readonly SpinDraw[] {
		return [...this.q2, ...this.q1]
	}

	/** Is the queue full for the given side? */
	isFull(which: 1 | 2): boolean {
		return which === 1 ? this.q1.length >= this.capacity1 : this.q2.length >= this.capacity2
	}

	clear(): void {
		this.q1.length = 0
		this.q2.length = 0
	}
}
