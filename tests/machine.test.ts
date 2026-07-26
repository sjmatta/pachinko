import { beforeEach, describe, expect, it } from 'vitest'
import boardFile from '../boards/standard-light.board.json'
import type { BoardFile } from '../src/board/types'
import { createStreams } from '../src/core/rng'
import type { SensorKind } from '../src/core/sensors'
import { HoldQueue } from '../src/machine/hold-queue'
import type { SpinDraw } from '../src/machine/lottery'
import { Machine } from '../src/machine/machine'
import { PayoutLedger } from '../src/machine/payout'

const spec = (boardFile as BoardFile).spec

const fakeDraw = (outcome: 'LOSE' | 'JACKPOT' = 'LOSE'): SpinDraw => ({
	outcome,
	pattern: 'NONE',
	reels: [0, 1, 2],
	durationMs: 100,
})

describe('hold queue (保留)', () => {
	it('caps each side independently and counts what it turned away', () => {
		const q = new HoldQueue(4, 4)
		for (let i = 0; i < 6; i++) q.push(fakeDraw(), 1)
		expect(q.count1).toBe(4)
		expect(q.overflow1).toBe(2)
		expect(q.overflow2).toBe(0)
		expect(q.push(fakeDraw(), 2)).toBe(true)
		expect(q.count2).toBe(1)
	})

	/**
	 * 特図2優先消化. During ST every spin arrives from the electric tulip, and
	 * draining that side first is what keeps the machine spinning off the right
	 * of the board while any leftover centre holds wait their turn.
	 */
	it('drains the tulip side before the centre side', () => {
		const q = new HoldQueue(4, 4)
		q.push(fakeDraw(), 1)
		q.push(fakeDraw(), 2)
		expect(q.shift()?.which).toBe(2)
		expect(q.shift()?.which).toBe(1)
		expect(q.shift()).toBeUndefined()
	})
})

describe('payout ledger', () => {
	it('debits on launch and refunds a foul without inflating the count', () => {
		const l = new PayoutLedger(10)
		expect(l.takeForLaunch()).toBe(true)
		expect(l.balance).toBe(9)
		expect(l.launched).toBe(1)
		l.refundFoul()
		expect(l.balance).toBe(10)
		expect(l.launched).toBe(0)
	})

	it('refuses to launch from an empty tray', () => {
		const l = new PayoutLedger(1)
		expect(l.takeForLaunch()).toBe(true)
		expect(l.takeForLaunch()).toBe(false)
	})

	/** Awards count immediately; the tray animation is only an animation. */
	it('books an award at once and dispenses it over time', () => {
		const l = new PayoutLedger(0)
		l.award(15)
		expect(l.paid).toBe(15)
		expect(l.balance).toBe(0)
		let guard = 0
		while (l.pendingCount > 0 && guard++ < 1000) l.dispense(0.05)
		expect(l.balance).toBe(15)
	})
})

describe('machine state machine', () => {
	let machine: Machine
	const hit = (kind: SensorKind, ballId = 1) => machine.onSensor({ kind, id: kind, ballId })
	const advance = (seconds: number) => {
		for (let i = 0; i < Math.ceil(seconds * 240); i++) machine.update(1 / 240)
	}

	beforeEach(() => {
		machine = new Machine(spec, createStreams(4242), 1000)
	})

	it('starts in normal play, aiming left', () => {
		expect(machine.mode).toBe('NORMAL')
		expect(machine.hitSide).toBe('LEFT')
	})

	it('pays the start pocket and banks a spin on entry', () => {
		hit('heso')
		expect(machine.ledger.paid).toBe(spec.payouts.heso)
		expect(machine.holds.total).toBe(1)
	})

	/**
	 * The through-gate is a gate, not a pocket. Paying for it is an easy mistake
	 * and it inflates the machine's return by several percent.
	 */
	it('pays nothing for the through-gate', () => {
		hit('gate')
		expect(machine.ledger.paid).toBe(0)
	})

	it('opens the tulip when the gate lottery wins, and closes it again', () => {
		// Under support the gate is all but certain, so one pass is enough.
		machine.stRemaining = 10
		for (let i = 0; i < 20 && !machine.denchuOpen; i++) hit('gate', i)
		expect(machine.denchuOpen).toBe(true)
		advance(spec.denchuOpenMsSupport / 1000 + 0.2)
		expect(machine.denchuOpen).toBe(false)
	})

	it('refunds a foul rather than counting it as played', () => {
		machine.requestLaunch()
		const before = machine.ledger.balance
		hit('foul')
		expect(machine.ledger.balance).toBe(before + 1)
	})

	it('runs a full jackpot: rounds, attacker payouts, then ST', () => {
		// Force a win rather than waiting for one; the lottery is tested
		// separately, and what matters here is what the machine does with it.
		const variant = spec.jackpotVariants.find((v) => v.st)!
		machine.holds.push(
			{ outcome: 'JACKPOT', pattern: 'REACH', reels: [3, 3, 3], durationMs: 800, variant },
			1,
		)

		advance(0.2) // spin starts
		expect(machine.phase).toBe('SPINNING')
		// 800 ms spin + 600 ms stop + a 4 s jackpot intro before round 1 opens.
		advance(7)
		expect(machine.currentRound).toBe(1)
		expect(machine.attackerOpen).toBe(true)
		expect(machine.hitSide).toBe('RIGHT')

		for (let round = 1; round <= variant.rounds; round++) {
			for (let b = 0; b < spec.ballsPerRound; b++) hit('attacker', b)
			advance(spec.roundIntervalMs / 1000 + 0.1)
		}
		advance(3)

		expect(machine.jackpots).toBe(1)
		expect(machine.ledger.paid).toBe(variant.rounds * spec.ballsPerRound * spec.payouts.attacker)
		expect(machine.mode).toBe('ST')
		expect(machine.hitSide).toBe('RIGHT')
		expect(machine.stRemaining).toBe(variant.stSpins)
	})

	it('ignores attacker hits while the attacker is shut', () => {
		hit('attacker')
		expect(machine.ledger.paid).toBe(0)
	})

	it('ends a round on the timeout even if the balls never arrive', () => {
		const variant = spec.jackpotVariants[0]!
		machine.holds.push(
			{ outcome: 'JACKPOT', pattern: 'REACH', reels: [1, 1, 1], durationMs: 800, variant },
			1,
		)
		advance(7)
		expect(machine.currentRound).toBe(1)
		advance(spec.roundTimeoutMs / 1000 + spec.roundIntervalMs / 1000 + 0.2)
		expect(machine.currentRound).toBe(2)
	})

	it('counts ST down per spin and drops back to left-hit when it runs out', () => {
		machine.stRemaining = 2
		expect(machine.hitSide).toBe('RIGHT')
		for (let i = 0; i < 2; i++) {
			hit('denchu', i)
			advance(spec.spinMs.superReach / 1000 + 2)
		}
		expect(machine.stRemaining).toBe(0)
		expect(machine.mode).toBe('NORMAL')
		expect(machine.hitSide).toBe('LEFT')
	})
})
