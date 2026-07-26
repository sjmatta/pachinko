/**
 * Headless balance harness.
 *
 * Nail placement is the machine's payout rate. You cannot derive it — the
 * numbers emerge from a chaotic system and the only honest way to know what a
 * board does is to fire a great many balls at it and count. This runs the exact
 * same `Game` the browser runs, with no renderer attached, and reports the
 * figures a real machine is specified by.
 *
 *   npm run soak -- --balls 20000 --seed 7 --handle 0.32
 *   npm run soak -- --sweep handle:0.2:0.9:0.05 --balls 4000
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BoardFile } from '../src/board/types'
import { SIM_DT } from '../src/core/units'
import { Game } from '../src/game'
import { initPhysics } from '../src/sim/world'

const here = dirname(fileURLToPath(import.meta.url))

interface Args {
	board: string
	balls: number
	seed: number
	handle: number
	rightHandle: number
	sweep?: { key: string; from: number; to: number; by: number }
	quiet: boolean
}

function parseArgs(argv: string[]): Args {
	const get = (name: string, fallback: string): string => {
		const i = argv.indexOf(`--${name}`)
		return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback
	}
	const sweepRaw = argv.indexOf('--sweep')
	let sweep: Args['sweep']
	if (sweepRaw >= 0 && argv[sweepRaw + 1]) {
		const [key, from, to, by] = argv[sweepRaw + 1]!.split(':')
		sweep = { key: key!, from: Number(from), to: Number(to), by: Number(by) }
	}
	return {
		board: get('board', 'standard-light'),
		balls: Number(get('balls', '20000')),
		seed: Number(get('seed', '1')),
		handle: Number(get('handle', '0.4')),
		rightHandle: Number(get('rightHandle', '0.55')),
		...(sweep ? { sweep } : {}),
		quiet: argv.includes('--quiet'),
	}
}

export interface SoakResult {
	handle: number
	ballsLaunched: number
	spins: number
	jackpots: number
	/**
	 * The headline number. Real machines are specified as "spins per ¥1000",
	 * and ¥1000 buys 250 balls, so this is the figure a player reads off the
	 * board before deciding whether to sit down. Typical tuning: 15–25.
	 */
	spinsPer250: number
	/** Balls returned per 100 launched during ordinary play. Real: ~25–35. */
	base: number
	/** Fraction of launched balls that reach the start pocket. Real: ~1 in 15. */
	hesoRate: number
	/** How many start-pocket entries arrived down the stage chute. */
	stageShare: number
	warpRate: number
	foulRate: number
	holdOverflow: number
	/** Balls the watchdog had to drain. Anything above zero is a board bug. */
	stuckReaped: number
	/** Balls paid out per ball launched, over the whole run. */
	rtp: number
	netBalls: number
	simSeconds: number
}

async function runOnce(
	file: BoardFile,
	balls: number,
	seed: number,
	handle: number,
	rightHandle: number,
) {
	await initPhysics()
	// A large starting balance so the run is never cut short by an empty tray;
	// we are measuring the board, not surviving a session.
	const game = await Game.create(file, seed, 10_000_000)

	/**
	 * Play the way the machine tells you to.
	 *
	 * Firing at one fixed handle position for the whole run models a player who
	 * ignores the 右打ち sign, and it silently destroys the return figure: ST is
	 * fed entirely by the electric tulip on the right side of the board, so a
	 * left-hitting run never converts a single jackpot into a chain and the
	 * measured payout comes out at a third of the truth.
	 */
	const follow = () => game.setHandle(game.machine.hitSide === 'RIGHT' ? rightHandle : handle, true)
	follow()

	const spec = file.spec
	let ticks = 0
	// Enough headroom after the last launch for balls in flight to settle.
	const maxTicks = Math.ceil((balls * 0.6 + 60) / SIM_DT)

	while (game.stats.launched < balls && ticks < maxTicks) {
		follow()
		game.step()
		ticks++
	}
	// Let the board drain, and let any jackpot in progress finish paying, so
	// the return figure counts the whole of the last win rather than half of it.
	const settleUntil = ticks + Math.ceil(120 / SIM_DT)
	game.setHandle(0, false)
	while (ticks < settleUntil && (game.sim.activeCount > 0 || game.machine.phase !== 'IDLE')) {
		game.step()
		ticks++
	}

	const s = game.stats
	const m = game.machine
	const launched = Math.max(1, s.launched)
	const paidBySmallPockets =
		s.hesoEntries * spec.payouts.heso +
		s.denchuEntries * spec.payouts.denchu +
		s.sidePocketEntries * spec.payouts.sidePocket

	const result: SoakResult = {
		handle,
		ballsLaunched: s.launched,
		spins: m.spins,
		jackpots: m.jackpots,
		spinsPer250: (m.spins / launched) * 250,
		base: (paidBySmallPockets / launched) * 100,
		hesoRate: s.hesoEntries / launched,
		stageShare: s.hesoEntries === 0 ? 0 : s.stageToHeso / s.hesoEntries,
		warpRate: s.warpEntries / launched,
		foulRate: s.fouls / launched,
		holdOverflow: m.holds.overflow1 + m.holds.overflow2,
		stuckReaped: game.sim.stuckReaped,
		rtp: m.ledger.paid / launched,
		netBalls: m.ledger.net,
		simSeconds: ticks * SIM_DT,
	}
	return result
}

/**
 * The two nails immediately above the start pocket, respaced.
 *
 * They are identified by position rather than by id, because "the pair sitting
 * symmetrically just above the heso sensor" is what they are — an id would only
 * be a second thing to keep in sync with the generator.
 */
function withHesoGap(file: BoardFile, gapMm: number): BoardFile {
	const heso = file.sensors.find((s) => s.kind === 'heso')!
	const pair = file.nails
		.filter((n) => Math.abs(Math.abs(n.x) - Math.abs(file.nails[0]!.x)) < 0.01 && n.y > heso.y)
		.slice(0, 2)
	if (pair.length !== 2) throw new Error('could not identify the 命釘 pair')
	const nailR = pair[0]!.r ?? 1.4
	const x = gapMm / 2 + nailR
	return {
		...file,
		nails: file.nails.map((n) =>
			n === pair[0] || n === pair[1] ? { ...n, x: Math.sign(n.x) * x } : n,
		),
	}
}

function report(r: SoakResult): void {
	const pct = (v: number) => `${(v * 100).toFixed(1)}%`
	console.log(`
handle ${r.handle.toFixed(2)}   ${r.ballsLaunched} balls   ${r.simSeconds.toFixed(0)}s simulated
  spins                 ${r.spins}  (${r.spinsPer250.toFixed(1)} per 250 balls)
  jackpots              ${r.jackpots}
  start-pocket rate     ${pct(r.hesoRate)}   (1 in ${(1 / Math.max(r.hesoRate, 1e-9)).toFixed(1)})
  via stage chute       ${pct(r.stageShare)} of those
  warp rate             ${pct(r.warpRate)}
  foul rate             ${pct(r.foulRate)}
  base (returned/100)   ${r.base.toFixed(1)}
  hold overflow         ${r.holdOverflow}
  stuck (watchdog)      ${r.stuckReaped}
  return                ${pct(r.rtp)}   net ${r.netBalls >= 0 ? '+' : ''}${r.netBalls} balls`)
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	const path = resolve(here, `../boards/${args.board}.board.json`)
	const file = JSON.parse(readFileSync(path, 'utf8')) as BoardFile

	if (args.sweep) {
		const { key, from, to, by } = args.sweep
		if (key !== 'handle' && key !== 'hesoGap') {
			throw new Error(`unsupported sweep key '${key}' (try handle or hesoGap)`)
		}
		console.log(`${key},spinsPer250,hesoRate,warpRate,foulRate,base,rtp`)
		for (let v = from; v <= to + 1e-9; v += by) {
			// Sweeping the 命釘 gap means moving two nails and nothing else, so
			// it is done on a copy of the loaded board rather than by
			// regenerating: a tenth of a millimetre here is the finest and most
			// consequential adjustment on the machine, and it deserves to be
			// measurable in one command.
			const variant = key === 'hesoGap' ? withHesoGap(file, v) : file
			const r = await runOnce(
				variant,
				args.balls,
				args.seed,
				key === 'handle' ? v : args.handle,
				args.rightHandle,
			)
			console.log(
				[
					v.toFixed(2),
					r.spinsPer250.toFixed(2),
					r.hesoRate.toFixed(4),
					r.warpRate.toFixed(4),
					r.foulRate.toFixed(4),
					r.base.toFixed(1),
					r.rtp.toFixed(3),
				].join(','),
			)
		}
		return
	}

	const r = await runOnce(file, args.balls, args.seed, args.handle, args.rightHandle)
	if (!args.quiet) report(r)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
