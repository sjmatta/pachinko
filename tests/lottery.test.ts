import { describe, expect, it } from 'vitest'
import boardFile from '../boards/standard-light.board.json'
import type { BoardFile } from '../src/board/types'
import { createStreams, Rng } from '../src/core/rng'
import { drawGate, drawSpin } from '../src/machine/lottery'

const spec = (boardFile as BoardFile).spec

describe('rng', () => {
	it('is reproducible from a seed', () => {
		const a = new Rng(1234)
		const b = new Rng(1234)
		const seqA = Array.from({ length: 200 }, () => a.next())
		const seqB = Array.from({ length: 200 }, () => b.next())
		expect(seqA).toEqual(seqB)
	})

	it('produces different streams from one master seed', () => {
		const s = createStreams(99)
		expect(s.jackpot.next()).not.toBe(s.contact.next())
	})

	it('round-trips its state', () => {
		const r = new Rng(7)
		for (let i = 0; i < 50; i++) r.next()
		const saved = r.getState()
		const expected = Array.from({ length: 10 }, () => r.next())
		r.setState(saved)
		expect(Array.from({ length: 10 }, () => r.next())).toEqual(expected)
	})

	it('holds the advertised odds', () => {
		const r = new Rng(2024)
		let hits = 0
		const n = 400_000
		for (let i = 0; i < n; i++) if (r.oneIn(99.9)) hits++
		// Within 6% relative of 1/99.9 over 400k draws.
		expect(hits / n).toBeGreaterThan((1 / 99.9) * 0.94)
		expect(hits / n).toBeLessThan((1 / 99.9) * 1.06)
	})
})

describe('spin lottery', () => {
	it('converges on the spec probability in normal play', () => {
		const rng = createStreams(5)
		let hits = 0
		const n = 200_000
		for (let i = 0; i < n; i++) {
			if (drawSpin(rng, spec, 'NORMAL').outcome === 'JACKPOT') hits++
		}
		expect(hits / n).toBeGreaterThan((1 / spec.normalOdds) * 0.9)
		expect(hits / n).toBeLessThan((1 / spec.normalOdds) * 1.1)
	})

	it('uses the raised ST probability during ST', () => {
		const rng = createStreams(6)
		let hits = 0
		const n = 100_000
		for (let i = 0; i < n; i++) {
			if (drawSpin(rng, spec, 'ST').outcome === 'JACKPOT') hits++
		}
		expect(hits / n).toBeGreaterThan((1 / spec.stOdds) * 0.9)
		expect(hits / n).toBeLessThan((1 / spec.stOdds) * 1.1)
	})

	/**
	 * The presentation must never be able to contradict the result, in either
	 * direction. Three matching symbols on a loss would be a machine that lies
	 * about paying; a win that does not show three matching symbols would be one
	 * that pays without saying so.
	 */
	it('never shows reels that disagree with the outcome', () => {
		const rng = createStreams(7)
		for (let i = 0; i < 60_000; i++) {
			const d = drawSpin(rng, spec, 'NORMAL')
			const [a, b, c] = d.reels
			const allMatch = a === b && b === c
			expect(allMatch).toBe(d.outcome === 'JACKPOT')
			if (d.outcome === 'LOSE' && d.pattern !== 'NONE') {
				// Every losing reach shows two matching reels and a third that
				// does not — that is what makes it a reach.
				expect(a).toBe(b)
				expect(c).not.toBe(a)
			}
			if (d.outcome === 'LOSE' && d.pattern === 'NONE') expect(a).not.toBe(b)
		}
	})

	it('always attaches a jackpot variant to a win and never to a loss', () => {
		const rng = createStreams(8)
		for (let i = 0; i < 40_000; i++) {
			const d = drawSpin(rng, spec, 'ST')
			expect(d.variant !== undefined).toBe(d.outcome === 'JACKPOT')
			if (d.variant) expect(d.variant.rounds).toBeGreaterThan(0)
		}
	})

	it('makes a super reach far more trustworthy than a bare spin', () => {
		const rng = createStreams(9)
		let superWins = 0
		let supers = 0
		for (let i = 0; i < 300_000; i++) {
			const d = drawSpin(rng, spec, 'NORMAL')
			if (d.pattern !== 'SUPER_REACH') continue
			supers++
			if (d.outcome === 'JACKPOT') superWins++
		}
		expect(supers).toBeGreaterThan(1000)
		// A super reach should convert far better than the base rate but still
		// lose most of the time — otherwise it is either meaningless or a promise.
		const rate = superWins / supers
		expect(rate).toBeGreaterThan(5 / spec.normalOdds)
		expect(rate).toBeLessThan(0.6)
	})
})

describe('gate lottery', () => {
	it('is close to dead in normal play and close to certain under support', () => {
		const rng = createStreams(11)
		const rate = (mode: 'NORMAL' | 'ST') => {
			let hits = 0
			for (let i = 0; i < 50_000; i++) if (drawGate(rng, spec, mode)) hits++
			return hits / 50_000
		}
		expect(rate('NORMAL')).toBeLessThan(0.05)
		expect(rate('ST')).toBeGreaterThan(0.9)
	})
})
