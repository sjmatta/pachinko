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
	poll(): HandleState
	dispose(): void
}

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

	poll(): HandleState {
		return this.state
	}

	dispose(): void {
		this.el.removeEventListener('pointerdown', this.onDown)
		this.el.removeEventListener('pointermove', this.onMove)
		this.el.removeEventListener('pointerup', this.onUp)
		this.el.removeEventListener('pointercancel', this.onUp)
	}
}

/** Keyboard: hold space to fire, arrows to trim the dial. */
export class KeyboardInput implements InputSource {
	private state: HandleState = { strength: 0.55, engaged: false }
	private up = false
	private down = false

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
	}

	poll(): HandleState {
		// Trim at a rate that makes single taps meaningful without making a held
		// key sweep the whole dial instantly.
		if (this.up) this.state.strength = clamp(this.state.strength + 0.006)
		if (this.down) this.state.strength = clamp(this.state.strength - 0.006)
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

	poll(): HandleState {
		const pads = navigator.getGamepads?.() ?? []
		for (const pad of pads) {
			if (!pad) continue
			const trigger = pad.buttons[7]
			if (!trigger) continue
			this.state.strength = clamp(trigger.value)
			this.state.engaged = trigger.value > 0.02
			return this.state
		}
		this.state.engaged = false
		return this.state
	}

	dispose(): void {}
}

/**
 * Whichever source moved most recently wins, so a player can pick up a
 * controller mid-session without anything having to be configured.
 */
export class CompositeInput implements InputSource {
	private last: HandleState = { strength: 0.55, engaged: false }

	constructor(private readonly sources: InputSource[]) {}

	poll(): HandleState {
		let active: HandleState | null = null
		for (const s of this.sources) {
			const st = s.poll()
			if (st.engaged) active = st
		}
		if (active) {
			this.last = { ...active }
			return this.last
		}
		return { strength: this.last.strength, engaged: false }
	}

	dispose(): void {
		for (const s of this.sources) s.dispose()
	}
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
