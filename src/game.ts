import { type Board, loadBoard, validateBoard } from './board/load'
import type { BoardFile } from './board/types'
import { createStreams, type RngStreams } from './core/rng'
import { SIM_DT } from './core/units'
import { Machine } from './machine/machine'
import { initPhysics, SimWorld } from './sim/world'

/**
 * The whole machine, physical and logical, with nothing platform-specific
 * attached.
 *
 * This is what the browser front end drives, what the unit tests instantiate,
 * and what the soak harness runs a hundred thousand balls through. There is no
 * renderer in the loop and no DOM anywhere beneath it, so all three get
 * identical behaviour — which is the only reason a balance figure measured in
 * CI means anything about the game a player actually gets.
 */
export class Game {
	readonly board: Board
	readonly sim: SimWorld
	readonly machine: Machine
	readonly rng: RngStreams

	/** Ball-level statistics the soak harness reports on. */
	readonly stats = {
		launched: 0,
		fouls: 0,
		hesoEntries: 0,
		denchuEntries: 0,
		attackerEntries: 0,
		sidePocketEntries: 0,
		gatePasses: 0,
		warpEntries: 0,
		stageToHeso: 0,
		drained: 0,
	}

	/** Ball ids that arrived via the stage centre chute, to attribute entries. */
	private fromStageChute = new Set<number>()

	constructor(file: BoardFile, seed = 1, startingBalance = 500) {
		const issues = validateBoard(file)
		for (const issue of issues) {
			const line = `board '${file.id}': ${issue.message}`
			if (issue.severity === 'error') throw new Error(line)
			console.warn(line)
		}
		this.board = loadBoard(file)
		this.rng = createStreams(seed)
		this.sim = new SimWorld(this.board, this.rng)
		this.machine = new Machine(this.board.spec, this.rng, startingBalance)

		this.sim.events.on('sensor', (hit) => {
			switch (hit.kind) {
				case 'heso':
					this.stats.hesoEntries++
					if (this.fromStageChute.delete(hit.ballId)) this.stats.stageToHeso++
					break
				case 'denchu':
					this.stats.denchuEntries++
					break
				case 'attacker':
					this.stats.attackerEntries++
					break
				case 'sidePocket':
					this.stats.sidePocketEntries++
					break
				case 'gate':
					this.stats.gatePasses++
					break
				case 'warp':
					this.stats.warpEntries++
					break
				case 'out':
					this.stats.drained++
					this.fromStageChute.delete(hit.ballId)
					break
				case 'foul':
					this.stats.fouls++
					break
			}
			// The machine learns what happened only through this one call.
			this.machine.onSensor(hit)
		})

		this.sim.events.on('stageExit', ({ ballId, via }) => {
			if (via === 'centre') this.fromStageChute.add(ballId)
		})
		this.sim.events.on('launched', () => {
			this.stats.launched++
		})
	}

	static async create(file: BoardFile, seed = 1, startingBalance = 500): Promise<Game> {
		await initPhysics()
		return new Game(file, seed, startingBalance)
	}

	/** One fixed physics step plus the machine logic for the same interval. */
	step(): void {
		this.sim.stepLauncher(() => this.machine.requestLaunch())
		this.sim.step(this.machine)
		this.machine.update(SIM_DT)
	}

	/** Handle position, 0..1. */
	setHandle(strength: number, engaged: boolean): void {
		this.sim.launcher.strength = Math.max(0, Math.min(1, strength))
		this.sim.launcher.engaged = engaged
	}
}
