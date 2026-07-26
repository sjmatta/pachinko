/**
 * Sound, synthesised.
 *
 * A pachinko hall's defining sound is thousands of steel balls hitting brass
 * pins — a dense, pitched clatter that no small set of samples reproduces
 * convincingly, because the whole character of it is that no two impacts are
 * alike. Generating each click from the impact that caused it gets that for
 * free, and it also means the project ships with no third-party audio and no
 * licensing question attached to it.
 */

export class Sfx {
	private ctx: AudioContext | null = null
	private master: GainNode | null = null
	private lastClick = 0
	muted = false

	/**
	 * Browsers — and iOS especially — will not start audio outside a user
	 * gesture, and iOS additionally wants a buffer actually played before it
	 * considers the context live.
	 */
	unlock(): void {
		if (this.ctx) {
			void this.ctx.resume()
			return
		}
		const Ctor =
			window.AudioContext ??
			(window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
		if (!Ctor) return
		this.ctx = new Ctor()
		this.master = this.ctx.createGain()
		this.master.gain.value = 0.5
		this.master.connect(this.ctx.destination)
		const silent = this.ctx.createBufferSource()
		silent.buffer = this.ctx.createBuffer(1, 1, 22050)
		silent.connect(this.master)
		silent.start()
	}

	/** A ball striking a nail. Pitch and level follow the impact speed. */
	click(speed: number): void {
		if (!this.ctx || !this.master || this.muted) return
		// The clatter is dense enough to swamp the mix if every contact is
		// played, so cap the rate and let the loud ones through.
		const now = this.ctx.currentTime
		if (now - this.lastClick < 0.012) return
		this.lastClick = now

		const level = Math.min(0.28, speed / 900)
		const osc = this.ctx.createOscillator()
		const gain = this.ctx.createGain()
		const filter = this.ctx.createBiquadFilter()
		filter.type = 'bandpass'
		filter.frequency.value = 1800 + Math.random() * 2600
		filter.Q.value = 6 + Math.random() * 6
		osc.type = 'triangle'
		osc.frequency.value = 900 + Math.random() * 1500
		gain.gain.setValueAtTime(level, now)
		gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.05)
		osc.connect(filter).connect(gain).connect(this.master)
		osc.start(now)
		osc.stop(now + 0.06)
	}

	/** A ball dropping into a paying pocket. */
	pocket(): void {
		this.tone([660, 990], 0.16, 0.16, 'sine')
	}

	/** A reel coming to rest. */
	reelStop(index: number): void {
		this.tone([420 + index * 120], 0.1, 0.13, 'square')
	}

	reachSting(): void {
		this.tone([300, 450, 600], 0.5, 0.13, 'sawtooth')
	}

	/** The fanfare. Deliberately the loudest thing the machine does. */
	jackpot(): void {
		const notes = [523, 659, 784, 1047, 784, 1047, 1319]
		notes.forEach((f, i) => {
			setTimeout(() => this.tone([f], 0.28, 0.2, 'square'), i * 110)
		})
	}

	private tone(freqs: number[], dur: number, level: number, type: OscillatorType): void {
		if (!this.ctx || !this.master || this.muted) return
		const now = this.ctx.currentTime
		for (const f of freqs) {
			const osc = this.ctx.createOscillator()
			const gain = this.ctx.createGain()
			osc.type = type
			osc.frequency.value = f
			gain.gain.setValueAtTime(0, now)
			gain.gain.linearRampToValueAtTime(level / freqs.length, now + 0.012)
			gain.gain.exponentialRampToValueAtTime(0.0008, now + dur)
			osc.connect(gain).connect(this.master)
			osc.start(now)
			osc.stop(now + dur + 0.02)
		}
	}
}
