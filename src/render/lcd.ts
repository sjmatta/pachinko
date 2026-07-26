import * as THREE from 'three'
import type { Board } from '../board/load'
import type { ReachPattern, SpinDraw } from '../machine/lottery'
import type { Mode } from '../machine/spec'

/**
 * The screen (液晶).
 *
 * On a modern machine most of the board is a large video panel, and the nail
 * field stands in front of it — which is why a pachinko hall looks like a wall
 * of televisions with pins on. It is drawn here into an ordinary 2D canvas and
 * mapped onto a plane behind the playfield: presentation code stays plain
 * canvas drawing, cheap to iterate on and completely separate from the 3D scene.
 *
 * Everything it shows is a *replay of a decision already made*. The reels are
 * handed their final symbols the moment the ball entered the pocket, and this
 * class has no access to the random number generator at all. It cannot change a
 * result, only dramatise one — which is exactly the guarantee a real machine's
 * sealed board provides, and the reason the presentation can be as theatrical
 * as it likes without anyone having to trust it.
 */

const W = 1024
const H = 800
const SYMBOLS = ['1', '3', '5', '7', '9', '★', '◆', '●']
const SYMBOL_COLOURS = [
	'#7fd6ff',
	'#ffd166',
	'#a0ff9f',
	'#ff6b8b',
	'#c9a0ff',
	'#ffd166',
	'#7fd6ff',
	'#ff9f6b',
]

interface ReelState {
	/** Continuous position; the integer part selects the symbol. */
	pos: number
	speed: number
	stopAt: number | null
}

export interface LcdView {
	mode: Mode
	hits: 'LEFT' | 'RIGHT'
	balls: number
	spins: number
	holds1: number
	holds2: number
	supportRemaining: number
	round: number
	roundTotal: number
	roundBalls: number
	jackpotBalls: number
}

export class Lcd {
	readonly mesh: THREE.Mesh
	private readonly canvas: HTMLCanvasElement
	private readonly ctx: CanvasRenderingContext2D
	private readonly texture: THREE.CanvasTexture

	private reels: ReelState[] = [
		{ pos: 0, speed: 0, stopAt: null },
		{ pos: 0, speed: 0, stopAt: null },
		{ pos: 0, speed: 0, stopAt: null },
	]
	private draw: SpinDraw | null = null
	private elapsed = 0
	private duration = 0
	private pattern: ReachPattern = 'NONE'
	private banner: { text: string; until: number; colour: string } | null = null
	private view: LcdView = {
		mode: 'NORMAL',
		hits: 'LEFT',
		balls: 0,
		spins: 0,
		holds1: 0,
		holds2: 0,
		supportRemaining: 0,
		round: 0,
		roundTotal: 0,
		roundBalls: 0,
		jackpotBalls: 0,
	}
	private time = 0

	constructor(board: Board) {
		this.canvas = document.createElement('canvas')
		this.canvas.width = W
		this.canvas.height = H
		this.ctx = this.canvas.getContext('2d')!
		this.texture = new THREE.CanvasTexture(this.canvas)
		this.texture.colorSpace = THREE.SRGBColorSpace

		// Sized and placed to fill the centre unit's opening.
		const left = -9.6
		const right = 9.6
		const bottom = board.movers.length ? 19.8 : 19.8
		const top = 34.2
		this.mesh = new THREE.Mesh(
			new THREE.PlaneGeometry(right - left, top - bottom),
			new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }),
		)
		// In front of the board face but behind the nails: the screen shows
		// through the centre unit's opening with the pins standing over it,
		// which is the whole look of a modern machine. Put it behind the face
		// and the board simply has a dark hole in the middle of it.
		this.mesh.position.set((left + right) / 2, (bottom + top) / 2, -0.3)
	}

	// ── Driven by machine events ───────────────────────────────────────────

	startSpin(draw: SpinDraw): void {
		this.draw = draw
		this.pattern = draw.pattern
		this.elapsed = 0
		this.duration = draw.durationMs / 1000
		// Reels stop left to right; the last one carries the whole story, which
		// is why the machine spends most of a reach animation on it.
		const stops = [0.35, 0.55, 1.0]
		this.reels = draw.reels.map((symbol, i) => ({
			pos: Math.random() * SYMBOLS.length,
			speed: 14 + i * 1.5,
			stopAt: symbol + stops[i]! * 0,
		}))
		this.reelStops = draw.reels
		this.stopTimes = stops.map((f) => this.duration * f)
	}

	private reelStops: [number, number, number] = [0, 0, 0]
	private stopTimes: number[] = [0, 0, 0]

	showBanner(text: string, seconds: number, colour = '#ffd166'): void {
		this.banner = { text, until: this.time + seconds, colour }
	}

	update(dt: number, view: LcdView): void {
		this.time += dt
		this.view = view
		if (!this.draw) return
		this.elapsed += dt
		this.reels.forEach((r, i) => {
			if (this.elapsed < this.stopTimes[i]!) {
				r.pos = (r.pos + r.speed * dt) % SYMBOLS.length
			} else {
				// Ease onto the decided symbol rather than snapping, so the last
				// reel crawling into place reads as tension instead of a glitch.
				const target = this.reelStops[i]!
				let delta = target - r.pos
				while (delta > SYMBOLS.length / 2) delta -= SYMBOLS.length
				while (delta < -SYMBOLS.length / 2) delta += SYMBOLS.length
				r.pos += delta * Math.min(1, dt * 9)
				if (Math.abs(delta) < 0.002) r.pos = target
			}
		})
		if (this.elapsed > this.duration + 1.2) this.draw = null
	}

	// ── Drawing ────────────────────────────────────────────────────────────

	flush(): void {
		const c = this.ctx
		this.paintBackground(c)
		this.paintReels(c)
		this.paintHolds(c)
		this.paintStatus(c)
		if (this.banner && this.time < this.banner.until) this.paintBanner(c, this.banner)
		this.texture.needsUpdate = true
	}

	private paintBackground(c: CanvasRenderingContext2D): void {
		const jackpot = this.view.round > 0
		const g = c.createLinearGradient(0, 0, 0, H)
		if (jackpot) {
			g.addColorStop(0, '#3a1200')
			g.addColorStop(0.5, '#7a2a00')
			g.addColorStop(1, '#1a0800')
		} else if (this.view.mode === 'ST') {
			g.addColorStop(0, '#001c2e')
			g.addColorStop(0.5, '#00374f')
			g.addColorStop(1, '#000d16')
		} else {
			g.addColorStop(0, '#070d1c')
			g.addColorStop(0.6, '#0d1730')
			g.addColorStop(1, '#05080f')
		}
		c.fillStyle = g
		c.fillRect(0, 0, W, H)

		// A slow sweep of light so the panel never looks like a still image.
		const x = ((this.time * 90) % (W * 1.6)) - W * 0.3
		const sweep = c.createLinearGradient(x - 160, 0, x + 160, H)
		sweep.addColorStop(0, 'rgba(255,255,255,0)')
		sweep.addColorStop(0.5, 'rgba(255,255,255,0.05)')
		sweep.addColorStop(1, 'rgba(255,255,255,0)')
		c.fillStyle = sweep
		c.fillRect(0, 0, W, H)
	}

	private paintReels(c: CanvasRenderingContext2D): void {
		const reach = this.pattern !== 'NONE' && this.draw !== null
		const cy = 320
		const boxW = 210
		const boxH = 260
		const gap = 36
		const totalW = boxW * 3 + gap * 2
		const x0 = (W - totalW) / 2

		for (let i = 0; i < 3; i++) {
			const x = x0 + i * (boxW + gap)
			const spinning = this.draw !== null && this.elapsed < this.stopTimes[i]!
			// The third reel glows during a reach — the machine telling you it
			// knows something. It does.
			const hot = reach && i === 2 && !spinning === false
			c.save()
			c.fillStyle = 'rgba(0,0,0,0.55)'
			roundRect(c, x, cy - boxH / 2, boxW, boxH, 18)
			c.fill()
			c.strokeStyle = hot ? '#ff5d7e' : 'rgba(150,190,255,0.45)'
			c.lineWidth = hot ? 7 : 3
			c.stroke()
			c.clip()

			const r = this.reels[i]!
			const frac = r.pos - Math.floor(r.pos)
			for (let k = -1; k <= 1; k++) {
				const idx = (Math.floor(r.pos) + k + SYMBOLS.length * 2) % SYMBOLS.length
				const y = cy + (k - frac + 0.5) * boxH
				c.fillStyle = SYMBOL_COLOURS[idx]!
				c.font = 'bold 150px system-ui, sans-serif'
				c.textAlign = 'center'
				c.textBaseline = 'middle'
				c.globalAlpha = spinning ? 0.75 : 1
				c.fillText(SYMBOLS[idx]!, x + boxW / 2, y)
			}
			c.restore()
		}

		if (reach) {
			const label =
				this.pattern === 'SUPER_REACH'
					? 'SUPER REACH!!'
					: this.pattern === 'NEAR_MISS'
						? 'REACH…'
						: 'REACH!'
			c.font = 'bold 58px system-ui, sans-serif'
			c.textAlign = 'center'
			c.fillStyle = this.pattern === 'SUPER_REACH' ? '#ff5d7e' : '#ffd166'
			c.globalAlpha = 0.75 + 0.25 * Math.sin(this.time * 8)
			c.fillText(label, W / 2, 130)
			c.globalAlpha = 1
		}
	}

	/** 保留 — the lamps showing how many spins are banked. */
	private paintHolds(c: CanvasRenderingContext2D): void {
		const draw = (n: number, y: number, colour: string, label: string) => {
			c.font = '26px system-ui, sans-serif'
			c.textAlign = 'left'
			c.fillStyle = 'rgba(220,235,255,0.5)'
			c.fillText(label, 60, y + 8)
			for (let i = 0; i < 4; i++) {
				c.beginPath()
				c.arc(150 + i * 52, y, 17, 0, Math.PI * 2)
				c.fillStyle = i < n ? colour : 'rgba(255,255,255,0.13)'
				c.fill()
			}
		}
		draw(this.view.holds1, H - 96, '#7fd6ff', '保留')
		draw(this.view.holds2, H - 46, '#ffd166', '電チュー')
	}

	private paintStatus(c: CanvasRenderingContext2D): void {
		c.textAlign = 'right'
		c.font = 'bold 34px system-ui, sans-serif'
		c.fillStyle = '#dbe7ff'
		c.fillText(`${this.view.spins} 回転`, W - 50, 66)
		c.font = '26px system-ui, sans-serif'
		c.fillStyle = 'rgba(219,231,255,0.62)'
		c.fillText(`${this.view.balls} 玉`, W - 50, 106)

		if (this.view.round > 0) {
			c.textAlign = 'center'
			c.font = 'bold 74px system-ui, sans-serif'
			c.fillStyle = '#ffd166'
			c.fillText(`${this.view.round} / ${this.view.roundTotal} ROUND`, W / 2, 96)
			c.font = 'bold 46px system-ui, sans-serif'
			c.fillStyle = '#fff'
			c.fillText(`${this.view.jackpotBalls} 玉`, W / 2, H - 150)
		} else if (this.view.supportRemaining > 0) {
			c.textAlign = 'center'
			c.font = 'bold 46px system-ui, sans-serif'
			c.fillStyle = this.view.mode === 'ST' ? '#7fd6ff' : '#a0ff9f'
			c.fillText(`${this.view.mode}  残り ${this.view.supportRemaining}`, W / 2, 90)
		}

		// 右打ち — the instruction that makes the board's right-hand side worth
		// anything. Miss it and the machine simply stops paying.
		if (this.view.hits === 'RIGHT') {
			c.textAlign = 'center'
			c.font = 'bold 62px system-ui, sans-serif'
			c.fillStyle = `rgba(255,93,126,${0.55 + 0.45 * Math.sin(this.time * 6)})`
			c.fillText('▶ 右打ち ▶', W / 2, H - 210)
		}
	}

	private paintBanner(c: CanvasRenderingContext2D, banner: { text: string; colour: string }): void {
		c.save()
		c.textAlign = 'center'
		const pulse = 1 + 0.06 * Math.sin(this.time * 10)
		c.translate(W / 2, H / 2)
		c.scale(pulse, pulse)
		c.font = 'bold 110px system-ui, sans-serif'
		c.lineWidth = 14
		c.strokeStyle = 'rgba(0,0,0,0.75)'
		c.strokeText(banner.text, 0, 0)
		c.fillStyle = banner.colour
		c.fillText(banner.text, 0, 0)
		c.restore()
	}
}

function roundRect(
	c: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
): void {
	c.beginPath()
	c.moveTo(x + r, y)
	c.arcTo(x + w, y, x + w, y + h, r)
	c.arcTo(x + w, y + h, x, y + h, r)
	c.arcTo(x, y + h, x, y, r)
	c.arcTo(x, y, x + w, y, r)
	c.closePath()
}
