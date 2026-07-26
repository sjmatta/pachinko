import type { PhysicsDef } from '../board/types'
import type { Rng } from '../core/rng'
import { FEED_INTERVAL_S } from '../core/units'

/**
 * The handle (ハンドル).
 *
 * A real pachinko handle is a continuous dial, not a button. How far it is
 * turned sets how hard the hammer strikes, which sets how far around the guide
 * rail the ball travels before it drops into the playfield — and that single
 * analog value is the entire skill of the game. Turn it lightly and the ball
 * falls into the left field toward the start pocket; turn it hard and it
 * carries over the top and comes down the right side where the through-gate
 * and the attacker live. Nothing about left-hit and right-hit is a mode
 * switch; it is one dial and the board's geometry.
 *
 * Two details that look like noise and are not:
 *
 * - The dead zone. Below about a tenth of a turn the machine feeds nothing, so
 *   the handle has a definite "on" point the player can find by feel.
 * - The jitter. Real shots scatter by a few centimetres per second. Perfect
 *   repeatability would let a player park the dial on one spot and stop
 *   playing, which is exactly what the scatter prevents.
 */
export interface LaunchRequest {
	x: number
	y: number
	vx: number
	vy: number
}

const DEAD_ZONE = 0.1

export class Launcher {
	/** Handle position, 0..1, written by whichever input source is active. */
	strength = 0
	/** True while the player is actually touching the handle. */
	engaged = false

	private timer = 0

	constructor(
		private readonly physics: PhysicsDef,
		private readonly rng: Rng,
	) {}

	/**
	 * Advance the feed clock. Returns a launch request on the ticks where a
	 * ball is due — a real machine feeds exactly 100 balls a minute and no
	 * amount of enthusiasm on the handle speeds that up.
	 */
	step(dt: number): LaunchRequest | null {
		if (!this.engaged || this.strength < DEAD_ZONE) {
			// Releasing the handle stops the feed at once, but leaves the timer
			// where it was so a brief re-grip does not reset the cadence.
			return null
		}
		this.timer -= dt
		if (this.timer > 0) return null
		this.timer += FEED_INTERVAL_S

		const { minSpeed, maxSpeed, muzzle, angleDeg, jitterSigma } = this.physics.launch
		const t = (this.strength - DEAD_ZONE) / (1 - DEAD_ZONE)
		// Slightly super-linear, so the low half of the dial has the fine
		// control where the start pocket is and the top half covers the sweep
		// across to the right side.
		const speed = minSpeed + (maxSpeed - minSpeed) * t ** 1.15 + this.rng.gaussian(0, jitterSigma)
		const a = (angleDeg * Math.PI) / 180
		return {
			x: muzzle.x,
			y: muzzle.y,
			vx: Math.cos(a) * speed,
			vy: Math.sin(a) * speed,
		}
	}

	reset(): void {
		this.timer = 0
	}
}
