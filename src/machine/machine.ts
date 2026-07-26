import { Emitter } from '../core/events'
import type { RngStreams } from '../core/rng'
import type { SensorHit } from '../core/sensors'
import { HoldQueue } from './hold-queue'
import { drawGate, drawSpin, type SpinDraw } from './lottery'
import { PayoutLedger } from './payout'
import {
	type HitSide,
	hasSupport,
	hitSideFor,
	type JackpotVariant,
	type MachineSpec,
	type Mode,
} from './spec'

/**
 * Where the machine is in the spin/jackpot pipeline. This is orthogonal to the
 * probability state below: you can be spinning in ST, or in normal, and the
 * pipeline does not care.
 */
export type Phase =
	| 'IDLE'
	| 'SPINNING'
	| 'SPIN_STOP'
	| 'JACKPOT_INTRO'
	| 'ROUND_OPEN'
	| 'ROUND_INTERVAL'
	| 'JACKPOT_OUTRO'

export interface MachineEvents {
	spinStart: { draw: SpinDraw; which: 1 | 2 }
	spinStop: { draw: SpinDraw }
	holdChange: { count1: number; count2: number }
	holdOverflow: { which: 1 | 2 }
	jackpotStart: { variant: JackpotVariant }
	roundStart: { round: number; total: number }
	roundEnd: { round: number; balls: number }
	jackpotEnd: { totalBalls: number }
	modeChange: { mode: Mode; hitSide: HitSide }
	payout: { kind: string; count: number }
	gateWin: Record<string, never>
	denchu: { open: boolean }
	attacker: { open: boolean }
	launchBlocked: Record<string, never>
}

/**
 * The machine "brain board".
 *
 * Everything here is a pure function of the spec, the RNG streams and the
 * sensor hits handed to it. It never touches the DOM, three.js or Rapier, so
 * the exact same object drives the on-screen game, the unit tests and the
 * headless soak harness. If the presentation layer stalls or is absent, the
 * machine behaves identically — which is the property that makes the soak
 * numbers worth trusting.
 */
export class Machine {
	readonly events = new Emitter<MachineEvents>()
	readonly holds: HoldQueue
	readonly ledger: PayoutLedger

	phase: Phase = 'IDLE'
	/** Spins of ST remaining. */
	stRemaining = 0
	/** Spins of 時短 remaining. */
	jitanRemaining = 0

	/** Physical actuator state, read each tick by the simulation. */
	denchuOpen = false
	attackerOpen = false

	/** Session counters, surfaced by the HUD and the soak harness. */
	spins = 0
	jackpots = 0

	private phaseTimer = 0
	private currentDraw: SpinDraw | null = null
	private variant: JackpotVariant | null = null
	private round = 0
	private roundBalls = 0
	private jackpotBalls = 0
	private denchuTimer = 0
	private lastMode: Mode = 'NORMAL'

	constructor(
		readonly spec: MachineSpec,
		private readonly rng: RngStreams,
		startingBalance = 500,
	) {
		this.holds = new HoldQueue(spec.holdCapacity, spec.holdCapacity)
		this.ledger = new PayoutLedger(startingBalance)
	}

	/**
	 * The mode the player sees. Derived rather than stored, so it can never
	 * disagree with the pipeline state.
	 */
	get mode(): Mode {
		if (this.phase !== 'IDLE' && this.phase !== 'SPINNING' && this.phase !== 'SPIN_STOP') {
			return 'JACKPOT'
		}
		if (this.stRemaining > 0) return 'ST'
		if (this.jitanRemaining > 0) return 'JITAN'
		return 'NORMAL'
	}

	get hitSide(): HitSide {
		return hitSideFor(this.mode)
	}

	/** Spins left in whichever support state is running, for the HUD counter. */
	get supportRemaining(): number {
		return this.stRemaining > 0 ? this.stRemaining : this.jitanRemaining
	}

	/** Round display, zero when no jackpot is running. */
	get currentRound(): number {
		return this.round
	}

	get totalRounds(): number {
		return this.variant?.rounds ?? 0
	}

	/** Balls the attacker has paid out during the current jackpot. */
	get currentJackpotBalls(): number {
		return this.jackpotBalls
	}

	get currentRoundBalls(): number {
		return this.roundBalls
	}

	// ── Sensor intake ──────────────────────────────────────────────────────

	/**
	 * A ball tripped a sensor. Called from the simulation, synchronously,
	 * within the physics substep that detected it.
	 */
	onSensor(hit: SensorHit): void {
		switch (hit.kind) {
			case 'heso':
				this.pay('heso', this.spec.payouts.heso)
				this.startLottery(1)
				break
			case 'denchu':
				this.pay('denchu', this.spec.payouts.denchu)
				this.startLottery(2)
				break
			case 'attacker':
				this.onAttackerBall()
				break
			case 'sidePocket':
				this.pay('sidePocket', this.spec.payouts.sidePocket)
				break
			case 'gate':
				// The through-gate pays nothing. It is a gate, not a pocket —
				// treating it as a payout inflates the return rate by several
				// percent and is an easy mistake to make.
				this.onGate()
				break
			case 'warp':
			case 'out':
				break
			case 'foul':
				this.ledger.refundFoul()
				break
		}
	}

	private pay(kind: string, count: number): void {
		if (count <= 0) return
		this.ledger.award(count)
		this.events.emit('payout', { kind, count })
	}

	/**
	 * The lottery moment. A ball has just been swallowed by a start pocket and
	 * the result is decided *right here*, before any reel has moved. What the
	 * player is about to watch is a dramatisation of a number that already
	 * exists.
	 */
	private startLottery(which: 1 | 2): void {
		const draw = drawSpin(this.rng, this.spec, this.mode)
		if (!this.holds.push(draw, which)) {
			this.events.emit('holdOverflow', { which })
			return
		}
		this.events.emit('holdChange', { count1: this.holds.count1, count2: this.holds.count2 })
	}

	private onGate(): void {
		if (!drawGate(this.rng, this.spec, this.mode)) return
		this.events.emit('gateWin', {})
		const ms = hasSupport(this.mode) ? this.spec.denchuOpenMsSupport : this.spec.denchuOpenMsNormal
		// Re-winning while already open extends rather than restarts, matching
		// the way consecutive gate wins keep the tulip flapping during ST.
		this.denchuTimer = Math.max(this.denchuTimer, ms)
		if (!this.denchuOpen) {
			this.denchuOpen = true
			this.events.emit('denchu', { open: true })
		}
	}

	private onAttackerBall(): void {
		if (this.phase !== 'ROUND_OPEN') return
		this.pay('attacker', this.spec.payouts.attacker)
		this.jackpotBalls += this.spec.payouts.attacker
		this.roundBalls++
		if (this.roundBalls >= this.spec.ballsPerRound) this.endRound()
	}

	// ── Tick ───────────────────────────────────────────────────────────────

	/** Advance machine logic. `dt` is in seconds. */
	update(dt: number): void {
		const ms = dt * 1000
		this.ledger.dispense(dt)
		this.updateDenchu(ms)

		this.phaseTimer -= ms
		switch (this.phase) {
			case 'IDLE':
				this.tryStartSpin()
				break
			case 'SPINNING':
				if (this.phaseTimer <= 0) {
					this.events.emit('spinStop', { draw: this.currentDraw! })
					this.setPhase('SPIN_STOP', 600)
				}
				break
			case 'SPIN_STOP':
				if (this.phaseTimer <= 0) this.resolveSpin()
				break
			case 'JACKPOT_INTRO':
				if (this.phaseTimer <= 0) this.startRound(1)
				break
			case 'ROUND_OPEN':
				if (this.phaseTimer <= 0) this.endRound()
				break
			case 'ROUND_INTERVAL':
				if (this.phaseTimer <= 0) {
					if (this.round >= (this.variant?.rounds ?? 0)) this.setPhase('JACKPOT_OUTRO', 2400)
					else this.startRound(this.round + 1)
				}
				break
			case 'JACKPOT_OUTRO':
				if (this.phaseTimer <= 0) this.endJackpot()
				break
		}

		this.announceModeIfChanged()
	}

	private updateDenchu(ms: number): void {
		if (!this.denchuOpen) return
		this.denchuTimer -= ms
		if (this.denchuTimer <= 0) {
			this.denchuOpen = false
			this.denchuTimer = 0
			this.events.emit('denchu', { open: false })
		}
	}

	private setPhase(phase: Phase, ms: number): void {
		this.phase = phase
		this.phaseTimer = ms
	}

	private tryStartSpin(): void {
		const next = this.holds.shift()
		if (!next) return
		this.currentDraw = next.draw
		this.spins++
		// Support states burn down per spin, and running out of ST while a
		// jackpot spin is already banked is precisely the situation the
		// hold queue exists to make survivable.
		if (this.stRemaining > 0) this.stRemaining--
		else if (this.jitanRemaining > 0) this.jitanRemaining--

		this.setPhase('SPINNING', next.draw.durationMs)
		this.events.emit('spinStart', { draw: next.draw, which: next.which })
		this.events.emit('holdChange', { count1: this.holds.count1, count2: this.holds.count2 })
	}

	private resolveSpin(): void {
		const draw = this.currentDraw!
		if (draw.outcome === 'JACKPOT') {
			this.variant = draw.variant!
			this.jackpots++
			this.jackpotBalls = 0
			this.round = 0
			// A jackpot cancels any running support; what comes after is
			// decided entirely by the variant that was drawn.
			this.stRemaining = 0
			this.jitanRemaining = 0
			this.setPhase('JACKPOT_INTRO', 4000)
			this.events.emit('jackpotStart', { variant: this.variant })
		} else {
			this.currentDraw = null
			this.setPhase('IDLE', 0)
		}
	}

	private startRound(n: number): void {
		this.round = n
		this.roundBalls = 0
		this.attackerOpen = true
		this.setPhase('ROUND_OPEN', this.spec.roundTimeoutMs)
		this.events.emit('attacker', { open: true })
		this.events.emit('roundStart', { round: n, total: this.variant?.rounds ?? 0 })
	}

	private endRound(): void {
		if (this.phase !== 'ROUND_OPEN') return
		this.attackerOpen = false
		this.events.emit('attacker', { open: false })
		this.events.emit('roundEnd', { round: this.round, balls: this.roundBalls })
		this.setPhase('ROUND_INTERVAL', this.spec.roundIntervalMs)
	}

	private endJackpot(): void {
		const v = this.variant!
		this.stRemaining = v.st ? v.stSpins : 0
		this.jitanRemaining = v.st ? 0 : v.jitanSpins
		this.events.emit('jackpotEnd', { totalBalls: this.jackpotBalls })
		this.variant = null
		this.currentDraw = null
		this.setPhase('IDLE', 0)
	}

	/**
	 * ST expiring mid-session flips the machine back to left-hit. Announcing it
	 * is not decoration — the board geometry genuinely stops paying if the
	 * player keeps firing at the wrong side, exactly as on a real machine.
	 */
	private announceModeIfChanged(): void {
		const m = this.mode
		if (m === this.lastMode) return
		this.lastMode = m
		this.events.emit('modeChange', { mode: m, hitSide: hitSideFor(m) })
	}

	/** Fired when the player pulls the handle; false means the tray is empty. */
	requestLaunch(): boolean {
		if (this.ledger.takeForLaunch()) return true
		this.events.emit('launchBlocked', {})
		return false
	}
}
