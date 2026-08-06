/**
 * The handle, abstracted away from how it is being turned.
 *
 * A pachinko handle is an analog dial, and the whole skill of the game is where
 * you set it. That maps very differently onto the three targets: an analog
 * trigger on a Steam Deck is almost the real thing, a vertical drag is the best
 * a phone can do, and a keyboard has to fake continuous control out of key
 * repeats. Keeping them behind one interface means the game never learns which
 * it is talking to, and the two platform shells stay thin.
 */

export interface HandleState {
	/** 0..1. */
	strength: number
	/** True while the player is holding the handle; releasing stops the feed. */
	engaged: boolean
}

export interface InputSource {
	/**
	 * Read the handle. `dt` is the wall-clock time since the last poll, in
	 * seconds, and sources that ramp a value over time must use it rather than
	 * counting calls.
	 *
	 * Getting that wrong is not a small error. This used to be called from inside
	 * the 240 Hz fixed step and trim a fixed amount per call, which made the
	 * keyboard's dial speed a function of the physics rate: a 200 ms tap of the
	 * arrow key swept more than half the dial. Since where you set the dial *is*
	 * the game, that made the keyboard unplayable for anything finer than
	 * "left side" or "right side".
	 */
	poll(dt: number): HandleState
	dispose(): void
}

/**
 * How fast the arrow keys move the dial, in dial-fractions per second.
 *
 * A full sweep in about three seconds. Slow enough that a tap is a nudge of a
 * few percent, fast enough to cross from left-hit to right-hit without waiting.
 */
const TRIM_PER_SECOND = 0.34
/** Holding shift divides the trim rate by this, for placing the last percent. */
const FINE_TRIM_DIVISOR = 6

/** Pointer and touch: drag up the handle area to turn it. */
export class PointerInput implements InputSource {
	private state: HandleState = { strength: 0.4, engaged: false }
	private dragging = false
	private startY = 0
	private startStrength = 0.4

	constructor(private readonly el: HTMLElement) {
		el.addEventListener('pointerdown', this.onDown)
		el.addEventListener('pointermove', this.onMove)
		el.addEventListener('pointerup', this.onUp)
		el.addEventListener('pointercancel', this.onUp)
	}

	private onDown = (e: PointerEvent): void => {
		this.dragging = true
		this.startY = e.clientY
		this.startStrength = this.state.strength
		this.state.engaged = true
		this.el.setPointerCapture(e.pointerId)
	}

	private onMove = (e: PointerEvent): void => {
		if (!this.dragging) return
		// Dragging up increases strength. A full turn is about a third of the
		// screen, which keeps the useful band of the dial reachable with a thumb.
		const range = Math.max(240, this.el.clientHeight * 0.35)
		this.state.strength = clamp(this.startStrength + (this.startY - e.clientY) / range)
	}

	private onUp = (): void => {
		this.dragging = false
		this.state.engaged = false
	}

	poll(_dt: number): HandleState {
		return this.state
	}

	dispose(): void {
		this.el.removeEventListener('pointerdown', this.onDown)
		this.el.removeEventListener('pointermove', this.onMove)
		this.el.removeEventListener('pointerup', this.onUp)
		this.el.removeEventListener('pointercancel', this.onUp)
	}
}

/** Keyboard: hold space to fire, arrows to trim the dial, shift to trim finely. */
export class KeyboardInput implements InputSource {
	private state: HandleState = { strength: 0.55, engaged: false }
	private up = false
	private down = false
	private fine = false

	constructor() {
		addEventListener('keydown', this.onKey)
		addEventListener('keyup', this.onKey)
	}

	private onKey = (e: KeyboardEvent): void => {
		const on = e.type === 'keydown'
		if (e.code === 'Space') {
			this.state.engaged = on
			e.preventDefault()
		}
		if (e.code === 'ArrowUp') this.up = on
		if (e.code === 'ArrowDown') this.down = on
		this.fine = e.shiftKey
	}

	poll(dt: number): HandleState {
		const rate = TRIM_PER_SECOND / (this.fine ? FINE_TRIM_DIVISOR : 1)
		const dir = (this.up ? 1 : 0) - (this.down ? 1 : 0)
		if (dir !== 0) this.state.strength = clamp(this.state.strength + dir * rate * dt)
		return this.state
	}

	dispose(): void {
		removeEventListener('keydown', this.onKey)
		removeEventListener('keyup', this.onKey)
	}
}

/**
 * Gamepad: the right analog trigger *is* the handle.
 *
 * This is the closest any of the three gets to the real control, and it is the
 * reason the Steam Deck is a good home for this game — a continuous trigger
 * maps onto a continuous dial with nothing lost in between.
 */
export class GamepadInput implements InputSource {
	private state: HandleState = { strength: 0, engaged: false }

	poll(_dt: number): HandleState {
		const pads = navigator.getGamepads?.() ?? []
		for (const pad of pads) {
			if (!pad) continue
			const trigger = pad.buttons[7]
			if (!trigger) continue
			this.state.strength = clamp(trigger.value)
			// Above a resting trigger's drift, which on a worn pad is a couple of
			// percent — a drifting trigger that reads as "engaged" would take the
			// handle away from the keyboard for the whole session.
			this.state.engaged = trigger.value > TRIGGER_DEAD_ZONE
			return this.state
		}
		this.state.engaged = false
		return this.state
	}

	dispose(): void {}
}

const TRIGGER_DEAD_ZONE = 0.06

/**
 * Whichever source moved most recently wins, so a player can pick up a
 * controller mid-session without anything having to be configured.
 *
 * "Moved" is meant literally: a source whose dial value changed this frame takes
 * the handle. Falling back to the last engaged source in list order is not good
 * enough on its own, because an engaged-but-static source — a controller resting
 * against the sofa, a finger left on the dial — would hold the handle
 * indefinitely against a player actively using something else.
 */
export class CompositeInput implements InputSource {
	private readonly seen: number[]
	private last: HandleState = { strength: 0.55, engaged: false }
	/** Returned every poll, so the render loop allocates nothing. */
	private readonly out: HandleState = { strength: 0.55, engaged: false }

	constructor(private readonly sources: InputSource[]) {
		this.seen = sources.map(() => Number.NaN)
	}

	poll(dt: number): HandleState {
		let engaged: HandleState | null = null
		let moved: HandleState | null = null
		for (let i = 0; i < this.sources.length; i++) {
			const st = this.sources[i]!.poll(dt)
			const before = this.seen[i]!
			this.seen[i] = st.strength
			if (!st.engaged) continue
			engaged ??= st
			// NaN on the first poll, so a source cannot claim the handle merely by
			// existing.
			if (Math.abs(st.strength - before) > 1e-4) moved = st
		}
		const active = moved ?? engaged
		if (active) this.last = { strength: active.strength, engaged: true }
		this.out.strength = this.last.strength
		this.out.engaged = active !== null
		return this.out
	}

	dispose(): void {
		for (const s of this.sources) s.dispose()
	}
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
