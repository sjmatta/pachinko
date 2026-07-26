import type { StageDef } from '../board/types'
import type { Rng } from '../core/rng'

/**
 * The centre stage (ステージ).
 *
 * A real stage is a shallow shelf mounted *behind* the board plane, nearly
 * horizontal, reached through a warp tube on the flank of the centre unit. A
 * ball that finds it rolls side to side, losing speed, and if it happens to be
 * crawling as it crosses the centre slot it drops through a chute that empties
 * directly over the start pocket — very nearly a guaranteed spin. Players
 * genuinely learn to read stage timing, because the rolling is close to
 * deterministic.
 *
 * Simulating that in the vertical playfield plane would be nonsense: in-plane
 * gravity would just yank the ball off the shelf. So the stage is its own
 * one-dimensional simulation along the shelf's arc length, with a real gravity
 * term taken from the trough's height profile. It costs almost nothing, it is
 * closer to the physical truth than forcing it into 2D would be, and it makes
 * the stage-to-start-pocket rate a number the soak harness can tune directly.
 */

export interface StageBall {
	ballId: number
	/** Position along the shelf, world units. */
	s: number
	/** Velocity along the shelf, world units per second. */
	v: number
	/** Seconds spent on the stage, for the renderer and as a safety valve. */
	age: number
}

export type StageExit =
	| { ballId: number; via: 'centre'; x: number; y: number; vx: number; vy: number }
	| { ballId: number; via: 'side'; x: number; y: number; vx: number; vy: number }

const GRAVITY = 981

export class Stage {
	readonly balls: StageBall[] = []

	constructor(
		private readonly def: StageDef,
		private readonly rng: Rng,
	) {}

	/** Height of the trough at arc position `s`. */
	private height(s: number): number {
		const p = this.def.profile
		if (s <= p[0]!.s) return p[0]!.h
		if (s >= p[p.length - 1]!.s) return p[p.length - 1]!.h
		for (let i = 1; i < p.length; i++) {
			const a = p[i - 1]!
			const b = p[i]!
			if (s <= b.s) return a.h + ((b.h - a.h) * (s - a.s)) / (b.s - a.s)
		}
		return 0
	}

	/** Local slope, used as the along-shelf component of gravity. */
	private slope(s: number): number {
		const eps = 0.05
		return (this.height(s + eps) - this.height(s - eps)) / (2 * eps)
	}

	private get minS(): number {
		return this.def.profile[0]!.s
	}

	private get maxS(): number {
		return this.def.profile[this.def.profile.length - 1]!.s
	}

	/** A ball has come through the warp tube. */
	enter(ballId: number, entrySpeed: number): void {
		this.balls.push({
			ballId,
			s: this.minS,
			v: Math.abs(entrySpeed) * this.def.entrySpeedScale,
			age: 0,
		})
	}

	/** Advance the shelf. Returns any balls that have left it. */
	step(dt: number): StageExit[] {
		const exits: StageExit[] = []
		for (let i = this.balls.length - 1; i >= 0; i--) {
			const b = this.balls[i]!
			b.age += dt

			// Gravity along the shelf, quadratic drag, and a small stochastic
			// term standing in for the shelf's texture and the ball's spin.
			const a = -GRAVITY * this.slope(b.s) - this.def.drag * b.v * Math.abs(b.v)
			b.v += a * dt + this.rng.gaussian(0, this.def.noiseSigma) * dt
			b.s += b.v * dt

			const slot = this.def.centreSlot
			const overSlot = Math.abs(b.s - slot.s) < slot.width / 2
			// The slot only takes a ball that is genuinely crawling. Anything
			// still carrying speed rides straight over it, which is why a stage
			// entry is a chance rather than a certainty.
			if (overSlot && Math.abs(b.v) < slot.maxSpeed) {
				const e = this.def.chuteExit
				exits.push({ ballId: b.ballId, via: 'centre', x: e.x, y: e.y, vx: e.vx, vy: e.vy })
				this.balls.splice(i, 1)
				continue
			}

			// Off either end, or stuck long enough that something has gone
			// wrong: spat out of the nearest side exit.
			if (b.s <= this.minS || b.s >= this.maxS || b.age > 12) {
				const side = this.def.sideExits.reduce((best, cur) =>
					Math.abs(cur.s - b.s) < Math.abs(best.s - b.s) ? cur : best,
				)
				exits.push({
					ballId: b.ballId,
					via: 'side',
					x: side.x,
					y: side.y,
					vx: side.vx,
					vy: side.vy,
				})
				this.balls.splice(i, 1)
			}
		}
		return exits
	}

	clear(): void {
		this.balls.length = 0
	}
}
