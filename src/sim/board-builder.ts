import type RAPIER from '@dimforge/rapier2d-compat'
import { hubRadiusOf } from '../board/geometry'
import type { Board } from '../board/load'
import type { MaterialName, MoverDef, SensorDef, Vec2 } from '../board/types'
import type { SensorKind } from '../core/sensors'
import { NAIL_RADIUS } from '../core/units'

/** Everything the world needs to look up after the board has been built. */
export interface BuiltBoard {
	/** Collider handle → the sensor it belongs to. */
	sensorByCollider: Map<number, { id: string; kind: SensorKind; maxSpeed?: number }>
	/** Collider handles belonging to nails, for the contact-noise term. */
	nailColliders: Set<number>
	/** Kinematic parts the machine logic drives. */
	movers: Map<string, BuiltMover>
	/** Windmill bodies, exposed so the renderer can read their angle. */
	windmills: { id: string; body: RAPIER.RigidBody }[]
	/** Nail positions in world units, for instanced rendering. */
	nails: { x: number; y: number; r: number }[]
}

export interface BuiltMover {
	def: MoverDef
	body: RAPIER.RigidBody
	/** 0 = closed, 1 = open. Driven by the machine, eased by the world. */
	openness: number
}

const rad = (deg: number) => (deg * Math.PI) / 180

/**
 * Turn a loaded board into Rapier colliders.
 *
 * Static geometry is a handful of fixed bodies carrying many colliders each,
 * rather than one body per wall: the broad phase does not care, and it keeps
 * the body count — and therefore the solver's iteration order, and therefore
 * determinism — stable across board edits.
 */
export function buildBoard(R: typeof RAPIER, world: RAPIER.World, board: Board): BuiltBoard {
	const built: BuiltBoard = {
		sensorByCollider: new Map(),
		nailColliders: new Set(),
		movers: new Map(),
		windmills: [],
		nails: [],
	}

	const material = (name: MaterialName) => board.physics.materials[name]

	const staticBody = world.createRigidBody(R.RigidBodyDesc.fixed())

	const addPolyline = (points: Vec2[], name: MaterialName): void => {
		if (points.length < 2) return
		const verts = new Float32Array(points.length * 2)
		points.forEach((p, i) => {
			verts[i * 2] = p.x
			verts[i * 2 + 1] = p.y
		})
		const m = material(name)
		const desc = R.ColliderDesc.polyline(verts)
			.setRestitution(m.restitution)
			.setFriction(m.friction)
		world.createCollider(desc, staticBody)
	}

	for (const wall of board.walls) addPolyline(wall.points, wall.material)

	for (const arc of board.arcs) {
		const points: Vec2[] = []
		const span = arc.endDeg - arc.startDeg
		for (let i = 0; i <= arc.segments; i++) {
			const deg = arc.startDeg + (span * i) / arc.segments
			points.push({
				x: arc.centre.x + arc.radius * Math.cos(rad(deg)),
				y: arc.centre.y + arc.radius * Math.sin(rad(deg)),
			})
		}
		addPolyline(points, arc.material)
	}

	// Nails. `Max` restitution combining matters here: a chrome ball glancing a
	// chrome nail should keep the nail's liveliness rather than be averaged
	// down by the ball's own dull value, or the whole field goes limp.
	const nailMat = material('nail')
	for (const n of board.nails) {
		const r = n.r ?? NAIL_RADIUS
		const desc = R.ColliderDesc.ball(r)
			.setTranslation(n.x, n.y)
			.setRestitution(nailMat.restitution)
			.setRestitutionCombineRule(R.CoefficientCombineRule.Max)
			.setFriction(nailMat.friction)
		const collider = world.createCollider(desc, staticBody)
		built.nailColliders.add(collider.handle)
		built.nails.push({ x: n.x, y: n.y, r })
	}

	// Windmills (風車). Genuinely free-spinning bodies on a revolute joint —
	// the residual spin left by the previous ball is a real source of variance
	// in where the next one goes, and scripting the rotation would quietly
	// remove that.
	//
	// A real 風車 is a compact disc with short vanes around its rim, sized so an
	// 11 mm ball rides across the tips and cannot get in between them. Building
	// it any larger makes a bucket wheel: the ball drops into a pocket between
	// two vanes and rides round in it for the rest of the session. That was the
	// largest single source of wedged balls on the first board.
	for (const w of board.windmills) {
		const anchor = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(w.x, w.y))
		const hub = world.createRigidBody(
			R.RigidBodyDesc.dynamic().setTranslation(w.x, w.y).setAngularDamping(w.angularDamping),
		)
		const plastic = material('plastic')
		const hubRadius = hubRadiusOf(w)
		world.createCollider(
			R.ColliderDesc.ball(hubRadius)
				.setRestitution(plastic.restitution)
				.setFriction(plastic.friction)
				.setMass(0.001),
			hub,
		)
		for (let i = 0; i < w.blades; i++) {
			const angle = (i / w.blades) * Math.PI * 2
			// The vane spans hub rim to tip, so it is offset to the midpoint of
			// that span rather than to half the tip radius.
			const half = (w.tipRadius - hubRadius) / 2
			const mid = hubRadius + half
			const desc = R.ColliderDesc.cuboid(half, w.bladeWidth / 2)
				.setTranslation(Math.cos(angle) * mid, Math.sin(angle) * mid)
				.setRotation(angle)
				.setRestitution(plastic.restitution)
				.setFriction(plastic.friction)
				.setMass(0.0005)
			world.createCollider(desc, hub)
		}
		world.createImpulseJoint(
			R.JointData.revolute({ x: 0, y: 0 }, { x: 0, y: 0 }),
			anchor,
			hub,
			true,
		)
		built.windmills.push({ id: w.id, body: hub })
	}

	// Sensors. Every pocket mouth, the through-gate and the warp entrance.
	for (const s of board.sensors) built.sensorByCollider.set(addSensor(R, world, staticBody, s), s)

	// Movers: the tulip wings and the attacker shutter. Kinematic bodies with
	// real colliders — when the shutter is closed a ball genuinely rolls over
	// it, and when it drops the same ball genuinely falls in.
	const plastic = material('plastic')
	for (const m of board.movers) {
		const body = world.createRigidBody(
			R.RigidBodyDesc.kinematicPositionBased()
				.setTranslation(m.x, m.y)
				.setRotation(rad(m.closedDeg)),
		)
		// Rotating parts hinge at one end, so the plate is offset along its own
		// local +x; sliding parts are centred on their body.
		const offsetX = m.kind === 'denchuWing' ? m.halfW : 0
		const desc = R.ColliderDesc.cuboid(m.halfW, m.halfH)
			.setTranslation(offsetX, 0)
			.setRestitution(plastic.restitution)
			.setFriction(plastic.friction)
		world.createCollider(desc, body)
		built.movers.set(m.id, { def: m, body, openness: 0 })
	}

	return built
}

function addSensor(
	R: typeof RAPIER,
	world: RAPIER.World,
	parent: RAPIER.RigidBody,
	s: SensorDef,
): number {
	const desc = R.ColliderDesc.cuboid(s.w / 2, s.h / 2)
		.setTranslation(s.x, s.y)
		.setSensor(true)
		.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS)
	return world.createCollider(desc, parent).handle
}
