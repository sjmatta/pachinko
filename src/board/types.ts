import type { SensorKind } from '../core/sensors'
import type { MachineSpec } from '../machine/spec'

/**
 * The board file format.
 *
 * Everything geometric and numeric about a machine lives here, in
 * **millimetres**, because that is the unit real board drawings use and the
 * unit nail adjustment is discussed in. A 0.1 mm nudge to the pair of nails
 * above the start pocket visibly moves the machine's payout rate, so the
 * authoring unit needs to make that resolution natural to write.
 *
 * `board/load.ts` converts to world units (centimetres) exactly once.
 */

export interface Vec2 {
	x: number
	y: number
}

export type MaterialName =
	| 'nail'
	| 'rail'
	| 'guide'
	| 'plastic'
	| 'pocket'
	| 'stage'
	/** The centre unit's top cover — see the note on it in the generator. */
	| 'cover'

export interface Material {
	restitution: number
	friction: number
}

/** A chain of connected wall segments. */
export interface WallDef {
	id: string
	points: Vec2[]
	material: MaterialName
}

/** A circular arc wall, expanded into a polyline at load. */
export interface ArcDef {
	id: string
	centre: Vec2
	radius: number
	/** Degrees, measured counter-clockwise from +x. */
	startDeg: number
	endDeg: number
	segments: number
	material: MaterialName
}

export interface NailDef {
	id: string
	x: number
	y: number
	/** Optional per-nail radius override. */
	r?: number
	/**
	 * Marks a nail as part of a deliberately closed run — a guide row a ball is
	 * meant to ride along rather than pass through. Suppresses the "this gap is
	 * narrower than a ball" check, which is otherwise exactly the warning you
	 * want.
	 */
	closed?: boolean
}

export interface WindmillDef {
	id: string
	x: number
	y: number
	blades: number
	/** Distance from hub to blade tip. */
	tipRadius: number
	bladeWidth: number
	angularDamping: number
	/**
	 * Radius of the disc the vanes stand on. Defaults to a proportion of the tip
	 * radius. This is structure, not safety: what keeps the windmill from eating
	 * balls is the gap between the vane *tips* being narrower than a ball, which
	 * `validateBoard` checks.
	 */
	hubRadius?: number
}

export interface SensorDef {
	id: string
	kind: SensorKind
	/** Sensor bodies are axis-aligned boxes; enough for every pocket mouth. */
	x: number
	y: number
	w: number
	h: number
	/**
	 * Only trip for a ball slower than this, in mm/s.
	 *
	 * The foul hole needs it. It is a hole in the floor of the launch channel
	 * at the channel's lowest point, and a ball on its way out crosses that
	 * point at five metres a second — it flies over. A shot that failed to make
	 * it round comes back and dribbles to a halt in exactly the same place, and
	 * drops in. Without the speed gate the sensor either eats every shot or,
	 * placed uphill to avoid that, never catches the stalled ones at all — and
	 * a ball parked at the bottom of the channel blocks every ball behind it.
	 */
	maxSpeed?: number
}

/**
 * A kinematic part the machine logic drives: the electric tulip wings and the
 * attacker shutter. These are real colliders that really block balls — nothing
 * about a ball entering the attacker is scripted.
 */
export interface MoverDef {
	id: string
	kind: 'denchuWing' | 'attackerShutter'
	/** Which side, for the mirrored tulip wings. */
	side?: 'left' | 'right'
	/** Hinge position. */
	x: number
	y: number
	/** Half-extents of the moving plate. */
	halfW: number
	halfH: number
	closedDeg: number
	openDeg: number
	/** Shutters translate instead of rotating. */
	closedOffset?: Vec2
	openOffset?: Vec2
}

/**
 * The centre stage (ステージ).
 *
 * A real stage is a shelf set *behind* the board plane, nearly horizontal, on
 * which balls roll back and forth before dropping. Trying to simulate that in
 * the vertical playfield plane produces nonsense — in-plane gravity would just
 * pull the ball straight off. So the stage is a separate one-dimensional
 * simulation along the shelf's arc length, with its own real gravity term from
 * the trough's height profile. It is faithful (players genuinely learn stage
 * timing because the rolling is near-deterministic) and it makes the
 * stage-to-start-pocket rate a first-class number the soak harness can tune.
 */
export interface StageDef {
	/** Height profile of the trough: arc position `s` to height `h`, in mm. */
	profile: { s: number; h: number }[]
	/** The centre slot: fall through here and you drop onto the start pocket. */
	centreSlot: { s: number; width: number; maxSpeed: number }
	/** Where a ball leaving the centre slot re-enters the playfield. */
	chuteExit: { x: number; y: number; vx: number; vy: number }
	/** Where a ball that fails the centre slot is spat back out. */
	sideExits: { s: number; x: number; y: number; vx: number; vy: number }[]
	/** Quadratic drag coefficient along the shelf. */
	drag: number
	/** Per-step velocity noise, mm/s. */
	noiseSigma: number
	/** Fraction of entry speed retained on arriving at the shelf. */
	entrySpeedScale: number
}

export interface PhysicsDef {
	materials: Record<MaterialName, Material>
	ball: {
		restitution: number
		friction: number
		linearDamping: number
		angularDamping: number
	}
	/**
	 * Standard deviation of the random tangential kick applied at each nail
	 * contact, in mm/s.
	 *
	 * This is the one deliberately non-physical term in the simulation, and it
	 * earns its place. A real ball is loose between the board face and the
	 * glass and wobbles out of plane; a strict 2D sim has no way to express
	 * that, so identical shots fall in eerie repeating columns and the board
	 * reads as fake within seconds of watching it. The kick stands in for the
	 * missing third dimension. It draws from its own RNG stream so that tuning
	 * it never disturbs the lottery sequence.
	 */
	nailContactNoise: number
	launch: {
		/** Where the hammer strikes the ball, and the channel direction there. */
		muzzle: Vec2
		angleDeg: number
		/** Handle at zero strength still needs to move the ball somewhere. */
		minSpeed: number
		maxSpeed: number
		/** Shot-to-shot spread. Perfect repeatability makes aiming trivial. */
		jitterSigma: number
	}
}

/**
 * The launch channel, described explicitly rather than left implicit in the
 * wall list.
 *
 * The renderer needs it to draw the lane, and the validator needs it to catch
 * the mistake it exists to catch: board furniture accidentally authored into
 * the channel. Coordinates near the bottom-left of the board look like ordinary
 * playfield positions, but the channel wraps underneath and around them, so a
 * pocket placed there quietly swallows every ball on its way up the rail — and
 * from the numbers alone that looks like a nail-tuning problem, not a
 * misplaced pocket.
 */
export interface ChannelDef {
	centre: Vec2
	innerRadius: number
	outerRadius: number
	startDeg: number
	endDeg: number
}

export interface BoardFile {
	schemaVersion: 1
	id: string
	name: string
	units: 'mm'
	/** Playfield disc, used by the camera fit and the render layer. */
	field: { centre: Vec2; radius: number }
	channel: ChannelDef
	physics: PhysicsDef
	walls: WallDef[]
	arcs: ArcDef[]
	nails: NailDef[]
	windmills: WindmillDef[]
	sensors: SensorDef[]
	movers: MoverDef[]
	stage: StageDef
	spec: MachineSpec
}
