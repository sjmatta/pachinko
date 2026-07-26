import type { Machine } from '../machine/machine'
import type { SimWorld } from '../sim/world'

/**
 * The DOM overlay.
 *
 * Plain HTML rather than drawn into the canvas: text stays crisp at every
 * scale, it costs nothing in the frame budget, and it sits inside the phone's
 * safe area without any of it having to be reimplemented in a shader.
 */
export class Hud {
	private readonly el: HTMLElement
	private readonly handleFill: HTMLElement
	private readonly handleValue: HTMLElement
	private readonly chips: Record<string, HTMLElement> = {}

	constructor(root: HTMLElement) {
		this.el = root
		root.innerHTML = `
			<div class="row">
				<div class="chip"><span>玉 · balls</span><b data-k="balls">0</b></div>
				<div class="chip"><span>回転 · spins</span><b data-k="spins">0</b></div>
				<div class="chip"><span>大当り · jackpots</span><b data-k="jackpots">0</b></div>
				<div class="chip" data-k="modeChip"><span>状態 · mode</span><b data-k="mode">通常</b></div>
				<div class="chip"><span>盤上 · in play</span><b data-k="active">0</b></div>
			</div>
			<div></div>
			<div class="row bottom">
				<div class="hint">
					Hold <b>Space</b> to fire · <b>↑ ↓</b> trims the handle · or drag the dial.
					A gamepad's right trigger works as the handle directly.
					Turn it lightly to play the left field toward the start pocket; turn it up
					to send balls over the top into the right lane.
				</div>
				<div id="handle">
					<div class="fill" style="height:0%"></div>
					<div class="label">HANDLE</div>
					<div class="value">0%</div>
				</div>
			</div>`
		for (const node of root.querySelectorAll<HTMLElement>('[data-k]')) {
			this.chips[node.dataset.k!] = node
		}
		this.handleFill = root.querySelector('.fill')!
		this.handleValue = root.querySelector('.value')!
	}

	get handleElement(): HTMLElement {
		return this.el.querySelector('#handle')!
	}

	update(machine: Machine, sim: SimWorld, strength: number): void {
		const set = (k: string, v: string) => {
			const node = this.chips[k]
			if (node && node.textContent !== v) node.textContent = v
		}
		set('balls', String(machine.ledger.balance))
		set('spins', String(machine.spins))
		set('jackpots', String(machine.jackpots))
		set('active', String(sim.activeCount))

		const mode = machine.mode
		const label =
			mode === 'NORMAL'
				? '通常'
				: mode === 'JACKPOT'
					? `大当り ${machine.currentRound}/${machine.totalRounds}`
					: `${mode} 残${machine.supportRemaining}`
		set('mode', label)
		const chip = this.chips.modeChip
		if (chip) chip.className = `chip mode-${mode}${machine.hitSide === 'RIGHT' ? ' hot' : ''}`

		const pct = Math.round(strength * 100)
		this.handleFill.style.height = `${pct}%`
		this.handleValue.textContent = `${pct}%`
	}
}
