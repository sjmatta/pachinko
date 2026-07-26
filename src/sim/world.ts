import RAPIER from '@dimforge/rapier2d-compat'
import type { Board } from '../board/load'
import { Emitter } from '../core/events'
import type { RngStreams } from '../core/rng'
import { CAPTURES, type SensorHit } from '../core/sensors'
import { BALL_RADIUS, GRAVITY, RAPIER_LENGTH_UNIT, SIM_DT } from '../core/units'
import { type BuiltBoard, buildBoard } from './board-builder'
import { Launcher } from './launcher'
import { Stage } from './stage'

const MAX_BALLS = 160
/** Somewhere off-board to park pooled bodies. */
const GARAGE = { x: -1000, y: -1000 }
/** How fast the tulip wings and shutter travel between their two positions. */
const MOVER_SPEED = 9

export interface SimEvents {
	sensor: SensorHit
	/** A ball hit a nail hard enough to be worth a click. */
	nailHit: { ballId: number; x: number; y: number; speed: number }
	launched: { ballId: number }
	/** A ball disappeared into the warp and is now on the stage. */
	stageEnter: { ballId: number }
	stageExit: { ballId: number; via: 'centre' | 'side' }
}

/** Longer than any honest trip down the board; see `reapStuckBalls`. */
const STUCK_SECONDS = 45
/** Below this, in world units per second, a ball counts as resting. */
const STALL_SPEED = 2.5
const STALL_SECONDS = 0.4
/** Size of the cabinet's hum, as felt by a resting ball. */
const NUDGE = 7

interface BallSlot {
	body: RAPIER.RigidBody
	collider: RAPIER.Collider
	active: boolean
	/** Where the stage sim holds a ball that has left the playfield plane. */
	onStage: boolean
	/** Seconds since this ball was fired. */
	age: number
	/** Seconds spent effectively motionless. */
	stalledFor: number
	prevX: number
	prevY: number
}

let rapierReady: Promise<void> | null = null
/** Rapier's WASM is base64-inlined in the `-compat` build, so this resolves
 *  without a network fetch — which is what makes it work identically in Node,
 *  in a WKWebView served from a custom scheme, and in a browser. */
export function initPhysics(): Promise<void> {
	rapierReady ??= RAPIER.init()
	return rapierReady
}

/**
 * The physical machine.
 *
 * This layer knows where everything is and what touched what. It has no idea
 * what any of it means — it does not know what a jackpot is, and it cannot be
 * told. That is deliberate: it makes the machine logic testable without a
 * physics world, and the physics measurable without a machine.
 */
export class SimWorld {
	readonly events = new Emitter<SimEvents>()
	readonly world: RAPIER.World
	readonly built: BuiltBoard
	readonly launcher: Launcher
	readonly stage: Stage

	/** Balls currently on the board, for the HUD and the soak harness. */
	activeCount = 0
	/** Balls the watchdog had to drain. Should stay at zero. */
	stuckReaped = 0
	/** Where they were when it happened, for finding the geometry at fault. */
	readonly stuckSpots: { x: number; y: number }[] = []

	private readonly queue: RAPIER.EventQueue
	private readonly balls: BallSlot[] = []
	private readonly colliderToBall = new Map<number, number>()
	private readonly free: number[] = []
	/** Latches `ballId:sensorId` so a ball rattling in a pocket mouth is
	 *  counted once, not once per bounce. */
	private readonly tripped = new Set<string>()
	private readonly noiseScale: number

	constructor(
		readonly board: Board,
		private readonly rng: RngStreams,
	) {
		this.world = new RAPIER.World({ x: 0, y: GRAVITY })
		// Size Rapier's contact tolerances to the ball rather than to a
		// human-scale object. See the note on the constant — getting this wrong
		// breaks the machine in a way that looks like bad level design.
		this.world.lengthUnit = RAPIER_LENGTH_UNIT
		this.world.timestep = SIM_DT
		this.world.numSolverIterations = 4

		this.built = buildBoard(RAPIER, this.world, board)
		this.queue = new RAPIER.EventQueue(true)
		this.launcher = new Launcher(board.physics, rng.launch)
		this.stage = new Stage(board.stage, rng.stage)
		this.noiseScale = board.physics.nailContactNoise

		const b = board.physics.ball
		for (let i = 0; i < MAX_BALLS; i++) {
			const body = this.world.createRigidBody(
				RAPIER.RigidBodyDesc.dynamic()
					.setTranslation(GARAGE.x, GARAGE.y)
					.setLinearDamping(b.linearDamping)
					.setAngularDamping(b.angularDamping)
					// Shape-cast CCD. A ball leaves the hammer at ~6 m/s, which
					// is two and a half centimetres of travel per 240 Hz step
					// against a 1.4 mm nail radius — without this it passes
					// straight through the board.
					//
					// Only the shape-cast kind. Soft CCD's predictive
					// constraints reach far enough ahead to see the far wall of
					// the curved launch channel and brake the ball against it.
					.setCcdEnabled(true)
					.setEnabled(false),
			)
			const collider = this.world.createCollider(
				RAPIER.ColliderDesc.ball(BALL_RADIUS)
					.setMass(0.0055)
					.setRestitution(b.restitution)
					.setFriction(b.friction)
					.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
				body,
			)
			this.balls.push({
				body,
				collider,
				active: false,
				onStage: false,
				age: 0,
				stalledFor: 0,
				prevX: GARAGE.x,
				prevY: GARAGE.y,
			})
			this.colliderToBall.set(collider.handle, i)
			this.free.push(i)
		}
	}

	// ── Ball pool ──────────────────────────────────────────────────────────

	/**
	 * Bodies are created once and recycled. Creating and destroying them at
	 * runtime would churn Rapier's handles, which changes the solver's
	 * iteration order and quietly destroys reproducibility — the property the
	 * whole soak harness rests on.
	 */
	spawn(x: number, y: number, vx: number, vy: number): number {
		const id = this.free.pop()
		if (id === undefined) return -1
		const slot = this.balls[id]!
		slot.body.setEnabled(true)
		slot.body.setTranslation({ x, y }, true)
		slot.body.setLinvel({ x: vx, y: vy }, true)
		slot.body.setAngvel(0, true)
		slot.active = true
		slot.onStage = false
		slot.age = 0
		slot.stalledFor = 0
		slot.prevX = x
		slot.prevY = y
		this.activeCount++
		return id
	}

	release(id: number): void {
		const slot = this.balls[id]
		if (!slot?.active) return
		slot.active = false
		slot.onStage = false
		slot.body.setLinvel({ x: 0, y: 0 }, false)
		slot.body.setTranslation(GARAGE, false)
		slot.body.setEnabled(false)
		this.activeCount--
		this.free.push(id)
		for (const key of this.tripped) {
			if (key.startsWith(`${id}:`)) this.tripped.delete(key)
		}
	}

	/** Position of a ball, interpolated for rendering. */
	ballPosition(id: number, alpha: number): { x: number; y: number } | null {
		const slot = this.balls[id]
		if (!slot?.active || slot.onStage) return null
		const t = slot.body.translation()
		return {
			x: slot.prevX + (t.x - slot.prevX) * alpha,
			y: slot.prevY + (t.y - slot.prevY) * alpha,
		}
	}

	forEachBall(fn: (id: number, slot: { active: boolean; onStage: boolean }) => void): void {
		this.balls.forEach((slot, id) => {
			fn(id, slot)
		})
	}

	// ── Step ───────────────────────────────────────────────────────────────

	/**
	 * Advance one fixed physics step.
	 *
	 * Sensor events are drained here, inside the step, rather than once per
	 * rendered frame. A ball crossing the start pocket at 2.5 m/s is inside the
	 * 13 mm sensor for about five milliseconds — less than half a frame at
	 * 60 Hz — so polling at frame rate silently drops entries and every balance
	 * number downstream comes out wrong.
	 */
	step(machineState: { denchuOpen: boolean; attackerOpen: boolean }): void {
		this.updateMovers(machineState)

		for (const slot of this.balls) {
			if (!slot.active || slot.onStage) continue
			const t = slot.body.translation()
			slot.prevX = t.x
			slot.prevY = t.y
		}

		this.world.step(this.queue)
		this.queue.drainCollisionEvents((h1, h2, started) => {
			if (started) this.onCollision(h1, h2)
			else this.onSeparation(h1, h2)
		})
		this.stepStage()
		this.reapStuckBalls()
	}

	/** Release a speed-gated sensor's latch so the ball can trip it next pass. */
	private onSeparation(h1: number, h2: number): void {
		const ballId = this.colliderToBall.get(h1) ?? this.colliderToBall.get(h2)
		if (ballId === undefined) return
		const other = this.colliderToBall.has(h1) ? h2 : h1
		const sensor = this.built.sensorByCollider.get(other)
		if (sensor?.maxSpeed === undefined) return
		this.tripped.delete(`${ballId}:${sensor.id}`)
	}

	/**
	 * A ball that has been on the board for a very long time is wedged
	 * somewhere, and a wedged ball is worse than a lost one: it holds a slot in
	 * the pool forever and, if it is sitting in the launch channel, it blocks
	 * every shot behind it. Drain it and move on.
	 *
	 * This is a backstop, not a mechanism. If it ever fires in normal play the
	 * board geometry is wrong and the count below is how you find out.
	 */
	private reapStuckBalls(): void {
		for (let id = 0; id < this.balls.length; id++) {
			const slot = this.balls[id]!
			if (!slot.active || slot.onStage) continue
			slot.age += SIM_DT
			this.nudgeIfStalled(slot)
			if (slot.age < STUCK_SECONDS) continue
			this.stuckReaped++
			if (this.stuckSpots.length < 400) {
				const t = slot.body.translation()
				this.stuckSpots.push({ x: t.x, y: t.y })
			}
			this.events.emit('sensor', { kind: 'out', id: 'stuck', ballId: id })
			this.release(id)
		}
	}

	/**
	 * Keep resting balls moving.
	 *
	 * A ball can come to rest in the notch between two adjacent nails and stay
	 * there: the notch is a couple of millimetres deep and a shallow row does
	 * not supply the energy to climb out of it. A real machine never has this
	 * problem, because it is a large electromechanical object running at a
	 * hundred balls a minute and the whole cabinet hums — players can feel it
	 * through the seat. This reproduces that, and the alternative is a board
	 * that silently accumulates parked balls until the pool runs dry.
	 */
	private nudgeIfStalled(slot: BallSlot): void {
		const v = slot.body.linvel()
		if (Math.hypot(v.x, v.y) > STALL_SPEED) {
			slot.stalledFor = 0
			return
		}
		slot.stalledFor += SIM_DT
		if (slot.stalledFor < STALL_SECONDS) return
		slot.stalledFor = 0
		slot.body.setLinvel(
			{
				x: v.x + this.rng.contact.gaussian(0, NUDGE),
				y: v.y + Math.abs(this.rng.contact.gaussian(0, NUDGE)),
			},
			true,
		)
	}

	private onCollision(h1: number, h2: number): void {
		const ballId = this.colliderToBall.get(h1) ?? this.colliderToBall.get(h2)
		if (ballId === undefined) return
		const other = this.colliderToBall.has(h1) ? h2 : h1
		const slot = this.balls[ballId]!
		if (!slot.active || slot.onStage) return

		const sensor = this.built.sensorByCollider.get(other)
		if (sensor) {
			if (sensor.maxSpeed !== undefined) {
				const v = slot.body.linvel()
				if (Math.hypot(v.x, v.y) > sensor.maxSpeed) return
			}
			this.onSensor(ballId, sensor.id, sensor.kind)
			return
		}

		if (this.built.nailColliders.has(other)) this.onNailContact(ballId, slot)
	}

	/**
	 * The one deliberately non-physical term in the simulation.
	 *
	 * A real ball is loose in the few millimetres between the board face and
	 * the glass, and every nail it clips also nudges it out of plane. A strict
	 * 2D world has nowhere to put that, so identical shots fall in eerie
	 * repeating columns and the board reads as fake within seconds of watching
	 * it. A small random tangential kick at each nail contact stands in for the
	 * missing third dimension. It draws from its own RNG stream, so tuning the
	 * feel never disturbs a single lottery draw in a soak run.
	 */
	private onNailContact(ballId: number, slot: BallSlot): void {
		const v = slot.body.linvel()
		const speed = Math.hypot(v.x, v.y)
		const kick = this.rng.contact.gaussian(0, this.noiseScale)
		slot.body.setLinvel({ x: v.x + kick, y: v.y }, true)
		if (speed > 12) {
			const t = slot.body.translation()
			this.events.emit('nailHit', { ballId, x: t.x, y: t.y, speed })
		}
	}

	/**
	 * A speed-gated sensor can be crossed many times before it fires, so its
	 * latch has to be cleared each time the ball leaves — otherwise a fast pass
	 * over the foul hole permanently immunises the ball against ever falling
	 * into it.
	 */
	private onSensor(ballId: number, id: string, kind: SensorHit['kind']): void {
		const key = `${ballId}:${id}`
		if (this.tripped.has(key)) return
		this.tripped.add(key)

		this.events.emit('sensor', { kind, id, ballId })

		if (kind === 'warp') {
			// Off the playfield plane and onto the shelf behind it.
			const slot = this.balls[ballId]!
			const v = slot.body.linvel()
			slot.onStage = true
			slot.body.setEnabled(false)
			slot.body.setTranslation(GARAGE, false)
			this.stage.enter(ballId, Math.hypot(v.x, v.y))
			this.events.emit('stageEnter', { ballId })
			return
		}
		if (CAPTURES[kind]) this.release(ballId)
	}

	private stepStage(): void {
		for (const exit of this.stage.step(SIM_DT)) {
			const slot = this.balls[exit.ballId]
			if (!slot) continue
			slot.onStage = false
			slot.body.setEnabled(true)
			slot.body.setTranslation({ x: exit.x, y: exit.y }, true)
			slot.body.setLinvel({ x: exit.vx, y: exit.vy }, true)
			slot.prevX = exit.x
			slot.prevY = exit.y
			this.events.emit('stageExit', { ballId: exit.ballId, via: exit.via })
		}
	}

	/**
	 * Ease the tulip wings and the attacker shutter toward whatever the machine
	 * has decided. They are kinematic position-based bodies, so Rapier derives
	 * their velocity from the movement and a ball resting on a closing shutter
	 * gets pushed rather than swallowed.
	 */
	private updateMovers(state: { denchuOpen: boolean; attackerOpen: boolean }): void {
		for (const mover of this.built.movers.values()) {
			const want = mover.def.kind === 'attackerShutter' ? state.attackerOpen : state.denchuOpen
			const target = want ? 1 : 0
			const delta = MOVER_SPEED * SIM_DT
			mover.openness += Math.max(-delta, Math.min(delta, target - mover.openness))

			const d = mover.def
			if (d.kind === 'denchuWing') {
				const deg = d.closedDeg + (d.openDeg - d.closedDeg) * mover.openness
				mover.body.setNextKinematicRotation((deg * Math.PI) / 180)
			} else {
				const from = d.closedOffset ?? { x: 0, y: 0 }
				const to = d.openOffset ?? { x: 0, y: 0 }
				mover.body.setNextKinematicTranslation({
					x: d.x + from.x + (to.x - from.x) * mover.openness,
					y: d.y + from.y + (to.y - from.y) * mover.openness,
				})
			}
		}
	}

	/**
	 * Feed the launcher and put a ball on the board if one is due.
	 *
	 * The pool is checked before `canLaunch` is consulted, because `canLaunch`
	 * debits the tray — asking it and then failing to spawn would quietly eat
	 * one of the player's balls.
	 */
	stepLauncher(canLaunch: () => boolean): number | null {
		const req = this.launcher.step(SIM_DT)
		if (!req) return null
		if (this.free.length === 0) return null
		if (!canLaunch()) return null
		const id = this.spawn(req.x, req.y, req.vx, req.vy)
		if (id >= 0) this.events.emit('launched', { ballId: id })
		return id
	}

	moverOpenness(id: string): number {
		return this.built.movers.get(id)?.openness ?? 0
	}
}
