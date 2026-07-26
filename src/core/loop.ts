import { SIM_DT } from './units'

/**
 * Fixed-timestep accumulator.
 *
 * Physics must advance in constant 1/240 s steps or restitution and the CCD
 * shape-casts stop being reproducible — a ball's path through a nail field is
 * chaotic enough that a variable step turns every session into a different
 * game. The renderer runs at whatever the display gives it and interpolates
 * between the last two simulated states.
 */
export class FixedStepLoop {
	private accumulator = 0
	private lastTime = 0
	private running = false
	private rafId = 0

	/** Fraction of the way from the previous sim state to the current one. */
	alpha = 0

	constructor(
		private readonly step: (dt: number) => void,
		private readonly render: (alpha: number, frameDt: number) => void,
		/** Guard against a huge catch-up burst after a tab has been backgrounded. */
		private readonly maxStepsPerFrame = 12,
	) {}

	start(): void {
		if (this.running) return
		this.running = true
		this.lastTime = performance.now()
		const frame = (now: number): void => {
			if (!this.running) return
			this.rafId = requestAnimationFrame(frame)
			const frameDt = Math.min((now - this.lastTime) / 1000, 0.25)
			this.lastTime = now
			this.accumulator += frameDt

			let steps = 0
			while (this.accumulator >= SIM_DT && steps < this.maxStepsPerFrame) {
				this.step(SIM_DT)
				this.accumulator -= SIM_DT
				steps++
			}
			// If we blew the budget, drop the backlog rather than spiral.
			if (steps === this.maxStepsPerFrame) this.accumulator = 0

			this.alpha = this.accumulator / SIM_DT
			this.render(this.alpha, frameDt)
		}
		this.rafId = requestAnimationFrame(frame)
	}

	stop(): void {
		this.running = false
		cancelAnimationFrame(this.rafId)
	}
}
