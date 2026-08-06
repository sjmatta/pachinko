/**
 * Parametric generator for the reference board.
 *
 * The board JSON is the artifact the game loads, but hand-writing three hundred
 * nail coordinates is not authoring — it is data entry. This script holds the
 * layout as parameters so a nail row can be re-angled or the start-pocket gap
 * re-cut in one edit, regenerates the JSON, and the soak harness measures what
 * changed. That loop is the whole job: on a real machine the nails *are* the
 * payout rate.
 *
 *   npm run board
 */

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	distanceToArc,
	distanceToPolyline,
	FLUSH_MAX,
	TRAP_GAP_HI_RATIO,
	windmillNailClearance,
} from '../src/board/geometry'
import type {
	ArcDef,
	BoardFile,
	MoverDef,
	NailDef,
	SensorDef,
	Vec2,
	WallDef,
	WindmillDef,
} from '../src/board/types'
import type { MachineSpec } from '../src/machine/spec'

const here = dirname(fileURLToPath(import.meta.url))

// ── Board geometry, all millimetres ────────────────────────────────────────

/** Centre of the playfield disc. */
const C: Vec2 = { x: 0, y: 240 }
/** Outer guide rail (外レール): the physical edge of the board. */
const R_OUTER = 215
/** Inner guide rail (内レール): the launch channel's inner wall and, past the
 *  channel, the floor the playfield drains along. */
const R_INNER = 196

/**
 * The launch channel. It is sealed at 300° by a cap, the hammer strikes at
 * 285°, and the channel runs clockwise from there — down past the bottom of the
 * board, up the left side — to the exit at 105°, where the inner rail stops and
 * the ball is thrown out over the playfield.
 *
 * The foul hole sits at the channel's lowest point, because that is where a
 * ball that failed to make it round ends up. It is speed-gated rather than
 * placed out of the way: put it uphill of the low point to keep outgoing shots
 * off it and it never catches the stalled ones at all, and a single ball parked
 * at the bottom of the channel then blocks every shot behind it for the rest of
 * the session.
 */
const CH_START_DEG = 300
const CH_MUZZLE_DEG = 285
const CH_FOUL_DEG = 270
/**
 * Where the inner rail stops and the channel opens into the playfield.
 *
 * This angle is what makes the handle mean anything, and it is worth being
 * precise about why. A ball running inside the outer rail is held on it by the
 * rail's inward push, and the rail can only push — so the ball stays on it just
 * as long as the curve it needs is a curve gravity has not already provided:
 * `v² ≥ g·r·sinθ`. Climbing the left side, sinθ rises toward 1 at the top, so
 * every ball eventually reaches an angle it cannot hold, and *where* that
 * happens is set by how fast it is going. That is a continuous, monotonic map
 * from the dial to a release point, for free, out of the geometry.
 *
 * Ending the rail at the old 105° threw that away. 105° and 90° differ by
 * almost nothing in sinθ — 0.966 against 1.0 — so a ball fast enough to reach
 * the exit at all was already fast enough to carry on round the top, and the
 * release point was the same for every shot. The whole dial collapsed onto one
 * trajectory and a hood had to be bolted over the mouth to break it up, which
 * is why no shape of hood ever restored the difference: the difference had
 * already been thrown away upstream.
 *
 * Opening the channel at 132° gives the peel-off somewhere to happen. A weak
 * shot lets go high on the left and drops into the left field; a strong one
 * holds the rail over the top and round into the right lane. One dial, one
 * inequality.
 */
const CH_EXIT_DEG = 150
/**
 * The right lane (右打ちルート).
 *
 * A second annular channel, this one between the playfield's edge and the outer
 * rail on the right-hand side. A shot hard enough to carry the ball right over
 * the top of the board stays pinned to the outer rail all the way round into
 * it, and from there runs downhill past the through-gate, the tulip and the
 * attacker before draining.
 *
 * This is the whole of "right-hit". There is no mode switch and no teleport —
 * the machine simply tells the player to turn the handle further, and the
 * board's geometry does the rest. Left-hitting during a jackpot misses the
 * attacker entirely, and right-hitting during normal play misses the start
 * pocket, both for the same purely physical reason.
 *
 * The lane's inner wall has to start *above* the playfield, not beside it. Ending
 * it at the old 354° left the entire upper-right quadrant of the field draining
 * straight into the lane over an open edge, so a fifth of all balls reached the
 * through-gate no matter where the dial was set and no matter what shape the
 * rail exit was given — the measurements sat within noise of 20% across the
 * whole dial for eight different rail-exit geometries. Carrying the wall up to
 * 55° seals the lane, and then the only way in is over the top, which is the
 * one thing the handle controls.
 *
 * The pockets are notches in the *outer* rail rather than the inner wall,
 * because a ball running down a curve is thrown against the outside of it: a
 * pocket on the inner wall would almost never catch anything.
 */
const LANE_TOP_DEG = 55
const LANE_BOTTOM_DEG = CH_START_DEG
const GATE_DEG = 344
const ATTACKER_ARC: [number, number] = [303, 317]
const DENCHU_ARC: [number, number] = [322, 332]
/**
 * How far each tulip wing swings out of the rail line.
 *
 * Ninety degrees exactly, which puts each wing flat along the radial edge of
 * its own pocket box. Anything less leaves the wings standing in the middle of
 * the box, and then the notch is open but there is nowhere for the ball to go —
 * measured at 31 catches from 4,252 balls past the gate, which reads exactly
 * like a tulip that never opens.
 */
const DENCHU_SWING_DEG = 90
/**
 * How far the pocket boxes stand proud of the outer rail.
 *
 * Shallow on purpose. A ball arriving through the mouth is caught by a sensor
 * sitting in the middle of the box, and deepening the box gives the ball room
 * to drop past that sensor into the far corner — at 24 mm the attacker stopped
 * registering a single ball while the round counter ran happily to completion,
 * which is a remarkably quiet way for a machine to break.
 */
const POCKET_DEPTH = 17

/**
 * The centre unit (センター役物): a solid frame housing the LCD.
 *
 * Two clearances make it a gameplay object rather than a decoration. The
 * corridor above it is what a strong shot flies through to reach the right
 * lane. And the space below it has to be comfortably more than a ball tall:
 * leave only thirteen millimetres between its underside and the gathering ramp
 * and an eleven-millimetre ball is pinched between the two, so every ball is
 * turned away a few centimetres short of the start pocket and the pocket takes
 * nothing at all.
 */
const UNIT = { left: -96, right: 96, bottom: 194, top: 344 }
/** The warp mouth, cut into the unit's left flank. */
const WARP = { y: 258, h: 12 }

/**
 * 命釘 — the "life nails".
 *
 * The single pair of nails immediately above the start pocket. Their gap is the
 * most consequential number on the board: a tenth of a millimetre here moves
 * the machine's spin rate by a noticeable amount, which is why shop staff
 * adjust exactly these and why players squint at them before sitting down.
 * Surface-to-surface, in millimetres.
 */
const HESO_GAP = 12.4
const NAIL_R = 1.4
/** Kept here in millimetres so the placement rules read in board units. */
const BALL_DIA = 11
/** Everything about the start pocket sits below the centre unit's lower edge. */
const HESO_NAIL_Y = 142
const HESO_SENSOR_Y = 130

const rad = (deg: number) => (deg * Math.PI) / 180
const polar = (deg: number, r: number): Vec2 => ({
	x: C.x + r * Math.cos(rad(deg)),
	y: C.y + r * Math.sin(rad(deg)),
})

// ── Small authoring helpers ────────────────────────────────────────────────

const round = (v: number) => Math.round(v * 100) / 100

/** Is a point inside the playable disc, with margin for the nail itself? */
const inField = (x: number, y: number, margin = 8): boolean =>
	Math.hypot(x - C.x, y - C.y) < R_INNER - margin

/**
 * Is a point clear of the centre unit?
 *
 * The margin only needs to be a ball's width plus a little: too generous and it
 * silently swallows the road nails that run right along the unit's flanks —
 * which is where they belong, and where they have to be for a ball coming down
 * the outside to be steered back toward the middle.
 */
const clearOfUnit = (x: number, y: number, margin = 5): boolean =>
	x < UNIT.left - margin ||
	x > UNIT.right + margin ||
	y < UNIT.bottom - margin ||
	y > UNIT.top + margin

/**
 * Why a nail may not go here, or null if it may.
 *
 * Both cases are the same underlying rule: a ball caught between a nail and a
 * surface it cannot pass never comes out. The board's boundary is the surface
 * in the first case and a rotating blade in the second, and the second is
 * stricter because the blade actively drives balls into the gap.
 */
function trapReason(x: number, y: number, hugsWall: boolean): string | null {
	for (const w of windmills) {
		if (Math.hypot(x - w.x, y - w.y) < windmillNailClearance(w.tipRadius, NAIL_R, BALL_DIA)) {
			return `is inside ${w.id}'s reach`
		}
	}
	// The generator holds itself to a stricter standard than `validateBoard`
	// does. The validator has to accept any board, including one whose author
	// deliberately set a nail flush against a wall; scattered nails have no such
	// excuse, so here they simply stay away from walls altogether. A nail that
	// genuinely belongs against one says `hugsWall` and is checked for actually
	// touching it rather than hovering a few millimetres off.
	let gap = Number.POSITIVE_INFINITY
	let nearest = 'nothing'
	const consider = (id: string, d: number): void => {
		if (d - NAIL_R < gap) {
			gap = d - NAIL_R
			nearest = id
		}
	}
	for (const wall of walls) consider(`'${wall.id}'`, distanceToPolyline({ x, y }, wall.points))
	for (const arc of arcs) consider(`'${arc.id}'`, distanceToArc({ x, y }, arc))

	if (hugsWall) {
		return gap > FLUSH_MAX
			? `is meant to touch a wall but stands ${gap.toFixed(1)} mm off ${nearest}`
			: null
	}
	return gap < BALL_DIA * TRAP_GAP_HI_RATIO
		? `stands ${gap.toFixed(1)} mm off ${nearest}, close enough to trap a ball in the corner`
		: null
}

/**
 * Slide a nail radially outward until it is tight against the rail.
 *
 * For a run that has to reach the rim, the boundary is the awkward part: it
 * curves away as it descends, so a straight run drifts through the trap band on
 * its way out to meet it. Rather than bend the run, push the offending nails the
 * last few millimetres out to where the slot is too narrow to admit a ball at
 * all — which is what "reaches the rim" was always trying to say.
 */
function pushOntoRail(x: number, y: number): [number, number, boolean] {
	const d = Math.hypot(x - C.x, y - C.y)
	const want = R_INNER - NAIL_R
	// Only the outermost few are anywhere near the rail; the rest of the run is
	// out in open field and stays exactly where it was authored.
	if (R_INNER - d - NAIL_R >= BALL_DIA * TRAP_GAP_HI_RATIO) return [x, y, false]
	return [C.x + ((x - C.x) * want) / d, C.y + ((y - C.y) * want) / d, true]
}

/**
 * Nails are placed through this, in order of importance.
 *
 * Deliberate runs — the pair above the start pocket, the funnel shoulders, the
 * road nails — go down first and are placed exactly as authored. Scatter
 * lattices go down afterwards and any nail that would land too close to
 * something already placed is simply dropped. That ordering matters: a stray
 * lattice nail landing a millimetre from the start-pocket pair would rewrite
 * the machine's payout rate, and it would do it invisibly.
 */
class NailField {
	readonly nails: NailDef[] = []
	private seq = 0

	/** Two free-standing nails must leave a ball room, plus a little margin. */
	private static readonly MIN_OPEN_GAP = 11.4

	add(
		x: number,
		y: number,
		opts: { closed?: boolean; force?: boolean; hugsWall?: boolean } = {},
	): NailDef | null {
		if (!opts.force && (!inField(x, y) || !clearOfUnit(x, y))) return null
		if (!opts.force && this.tooClose(x, y, opts.closed ?? false)) return null
		// Trap checks apply to forced nails too, but they shout rather than
		// silently dropping: `force` means "place this exactly where I asked
		// despite the spacing heuristics", not "build a ball trap", and a
		// deliberate run authored into one is a mistake worth stopping the build.
		const trap = trapReason(x, y, opts.hugsWall ?? false)
		if (trap) {
			if (!opts.force) return null
			throw new Error(`forced nail at (${round(x)}, ${round(y)}) ${trap}`)
		}
		const n: NailDef = { id: `n${this.seq++}`, x: round(x), y: round(y) }
		if (opts.closed) n.closed = true
		this.nails.push(n)
		return n
	}

	private tooClose(x: number, y: number, closed: boolean): boolean {
		const limit = (closed ? 0 : NailField.MIN_OPEN_GAP) + NAIL_R * 2
		for (const n of this.nails) {
			const d = Math.hypot(n.x - x, n.y - y)
			// A candidate may sit tight against an existing closed run only if
			// it is part of a closed run itself.
			const needed = n.closed && closed ? NAIL_R * 2 + 0.2 : limit
			if (d < needed) return true
		}
		return false
	}

	/** A straight run. `closed` runs are guides balls ride along, not gaps. */
	row(from: Vec2, to: Vec2, count: number, closed = false): void {
		for (let i = 0; i < count; i++) {
			const t = count === 1 ? 0 : i / (count - 1)
			this.add(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, { closed })
		}
	}

	/** A staggered triangular lattice, clipped to the field and to the unit. */
	lattice(
		bounds: { x0: number; x1: number; y0: number; y1: number },
		dx: number,
		dy: number,
	): void {
		let rowIndex = 0
		for (let y = bounds.y0; y <= bounds.y1; y += dy, rowIndex++) {
			const offset = rowIndex % 2 === 0 ? 0 : dx / 2
			for (let x = bounds.x0 + offset; x <= bounds.x1; x += dx) this.add(x, y)
		}
	}
}

// ── Walls and arcs ─────────────────────────────────────────────────────────

const arcs: ArcDef[] = [
	// The outer rail. It is the polished band the ball rides all the way round
	// on a full-strength shot, so it gets the slickest material on the machine
	// — a ball that scrubs against it never reaches the right side. It runs
	// unbroken except where the two right-lane pockets are cut into it.
	{
		id: 'outerRailA',
		centre: C,
		radius: R_OUTER,
		startDeg: DENCHU_ARC[1],
		endDeg: 360 + ATTACKER_ARC[1],
		segments: 560,
		material: 'guide',
	},
	{
		id: 'outerRailB',
		centre: C,
		radius: R_OUTER,
		startDeg: ATTACKER_ARC[0],
		endDeg: DENCHU_ARC[0],
		segments: 12,
		material: 'guide',
	},
	// The inner rail: launch channel wall from the hammer round to the exit,
	// then the playfield's drain floor down the left and across the bottom.
	{
		id: 'innerRail',
		centre: C,
		radius: R_INNER,
		startDeg: CH_EXIT_DEG,
		endDeg: CH_START_DEG,
		segments: 300,
		material: 'rail',
	},
	// The right lane's inner wall. It is what keeps a right-hit ball out of the
	// playfield, and therefore what makes right-hitting during normal play a
	// genuine waste of balls rather than a scripted penalty.
	{
		id: 'laneInner',
		centre: C,
		radius: R_INNER,
		startDeg: LANE_BOTTOM_DEG,
		// Wrapped past 360°, because the lane runs up through the 3 o'clock
		// position: written as a bare 55 the arc sweeps the short way round and
		// walls off the left half of the board instead.
		endDeg: 360 + LANE_TOP_DEG,
		segments: 120,
		material: 'rail',
	},
]

const radialWall = (id: string, deg: number, r0: number, r1: number): WallDef => ({
	id,
	points: [polar(deg, r0), polar(deg, r1)],
	material: 'rail',
})

/** A pocket set into the outer rail, open toward the lane. */
const pocketBox = (id: string, [a, b]: [number, number]): WallDef => ({
	id,
	points: [
		polar(a, R_OUTER),
		polar(a, R_OUTER + POCKET_DEPTH),
		polar(b, R_OUTER + POCKET_DEPTH),
		polar(b, R_OUTER),
	],
	material: 'pocket',
})

const walls: WallDef[] = [
	// Seals the launch channel at the hammer end, and doubles as the floor the
	// right lane drains onto.
	radialWall('channelCap', CH_START_DEG, R_INNER, R_OUTER),

	// The two pocket boxes, standing proud of the outer rail.
	pocketBox('attackerBox', ATTACKER_ARC),
	pocketBox('denchuBox', DENCHU_ARC),

	// The centre unit: a solid frame with the warp mouth cut into its left
	// flank. Balls travel around it; only the warp leads inside.
	{
		id: 'unitLower',
		points: [
			{ x: UNIT.left, y: WARP.y - WARP.h / 2 },
			{ x: UNIT.left, y: UNIT.bottom + 14 },
			{ x: UNIT.left + 14, y: UNIT.bottom },
			{ x: UNIT.right - 14, y: UNIT.bottom },
			{ x: UNIT.right, y: UNIT.bottom + 14 },
			{ x: UNIT.right, y: UNIT.top - 16 },
		],
		material: 'plastic',
	},
	/**
	 * The unit's top cover, split out from the frame purely so it can carry its
	 * own material. Geometrically it is the same chain, and the two joints are
	 * shared points with the walls either side of it.
	 *
	 * The roof is pitched, not flat. A hundred and sixty millimetres of level
	 * plastic in the middle of the corridor is a shelf, and a ball that stops on
	 * it stays for the rest of the session. The pitch has to beat the surface's
	 * friction angle with margin, or balls sit on it anyway — at `cover`'s 0.14
	 * that is 8°, and this is 18°.
	 */
	{
		id: 'unitRoof',
		points: [
			{ x: UNIT.right, y: UNIT.top - 16 },
			{ x: UNIT.right - 16, y: UNIT.top },
			{ x: 0, y: UNIT.top + 26 },
			{ x: UNIT.left + 16, y: UNIT.top },
			{ x: UNIT.left, y: UNIT.top - 16 },
		],
		material: 'cover',
	},
	{
		id: 'unitUpperLeft',
		points: [
			{ x: UNIT.left, y: UNIT.top - 16 },
			{ x: UNIT.left, y: WARP.y + WARP.h / 2 },
		],
		material: 'plastic',
	},
	// A hood over the warp mouth. Without it every ball sliding down the unit's
	// left face drops straight in and a fifth of the board ends up on the
	// stage; a real warp takes a few percent. The ball has to arrive on an
	// upward bounce to get under the hood, which is what makes finding it feel
	// like luck rather than routing.
	//
	// It descends *away* from the unit, and that direction is the whole of it.
	// Sloped the other way — down toward the face, which is the natural way to
	// draw a hood — its upper surface and the unit's vertical flank form a
	// closed V, and balls rolling down the flank come to rest in it and never
	// leave. That corner alone accounted for a twentieth of every ball fired.
	{
		id: 'warpHood',
		points: [
			{ x: UNIT.left, y: WARP.y + WARP.h / 2 + 8 },
			{ x: UNIT.left - 5, y: WARP.y + WARP.h / 2 + 4 },
			{ x: UNIT.left - 11, y: WARP.y + WARP.h / 2 - 2 },
		],
		material: 'plastic',
	},
	{
		id: 'warpFloor',
		// A scoop projecting into the corridor. A warp flush with the unit's
		// flank catches nothing at all: balls coming down the corridor are not
		// hugging the face, so the mouth has to reach out for them.
		points: [
			{ x: UNIT.left - 20, y: WARP.y - WARP.h / 2 - 10 },
			{ x: UNIT.left - 9, y: WARP.y - WARP.h / 2 - 4 },
			{ x: UNIT.left, y: WARP.y - WARP.h / 2 },
		],
		material: 'plastic',
	},

	// The start pocket cup, directly under the 命釘.
	//
	// Each wall begins *on* the nail above it rather than a few millimetres
	// inboard. Set it back and the nail and the cup lip form an open corner a
	// ball's width across, in the one place on the board where every ball is
	// heading — and balls settle into it instead of falling through the gap.
	// Starting flush leaves no corner at all: the 命釘 gap simply becomes the
	// mouth of the cup, which is what it looks like on a real board anyway.
	//
	// The walls diverge slightly on the way down. A funnel that narrows would
	// wedge a ball above the sensor; widening cannot.
	hesoCupWall('hesoCupLeft', -1),
	hesoCupWall('hesoCupRight', 1),

	/**
	 * 返し — the return-prevention flap at the channel mouth.
	 *
	 * There used to be a hood here, a scoop attached to the outer rail that
	 * turned every ball off it and into the field, because with the channel
	 * opening at 105° nothing else broke the shots apart. It could not work:
	 * anything anchored to the outer rail stands in the path of the very ball
	 * that is supposed to ride past it, so the hood decided the route instead of
	 * the handle. Eight shapes were measured — short lip, long lip, gentle
	 * spiral, springy, dead — and the share of balls reaching the right lane
	 * stayed within noise of 20% across the whole dial for all of them.
	 *
	 * With the channel opening at 132° the peel-off does that job, and does it as
	 * a smooth function of speed instead of a coin toss. So all that is left here
	 * is the flap's original job: sitting on the inner rail's tip, out of the
	 * outer rail's way, so a ball wandering the upper-left field cannot drop back
	 * into the mouth it came out of.
	 */
	{
		id: 'railExitFlap',
		points: [
			polar(CH_EXIT_DEG, R_INNER),
			polar(CH_EXIT_DEG - 5, R_INNER + 5),
			polar(CH_EXIT_DEG - 11, R_INNER + 7),
		],
		material: 'guide',
	},

	// 一般入賞口 — side pockets. They pay but never spin, and they are most of
	// what keeps the base rate up during ordinary play. Both sit on the left,
	// because the left is the normal-play route: the right side of the board
	// belongs to the tulip and the attacker.
	sidePocketWall('sideL1', -96, 104),
	sidePocketWall('sideL2', 96, 104),
]

/**
 * A pocket mouth barely wider than a ball, with near-vertical walls.
 *
 * The flared lead-in that looks right on paper is the problem: a 26 mm funnel
 * anywhere in the lower field catches close to half of everything fired, and at
 * three balls a time that alone puts the machine near 180% return. Guarding it
 * with nails does not help — they funnel too. The mouth itself has to be the
 * width of a ball and no more.
 *
 * It also has to sit well clear of the drain floor, and that is not a detail.
 * Sat a centimetre above it, the box's outer wall is a dam: the floor slopes
 * down from the left, the wall's underside stops a ball dead, and the balls
 * behind it stack up until a dozen are parked in the corner. Rapier's contact
 * query is what finally showed it — every ball in the heap was resting on other
 * balls, not on any piece of the board.
 */
/** One side of the start-pocket cup, hung off the 命釘 on that side. */
function hesoCupWall(id: string, side: -1 | 1): WallDef {
	const nailX = side * (HESO_GAP / 2 + NAIL_R)
	// A point on the nail's surface, on the pocket side and just below centre,
	// so wall and nail touch and there is no notch between them.
	const from = { x: nailX - side * NAIL_R * 0.7, y: HESO_NAIL_Y - NAIL_R * 0.7 }
	return {
		id,
		points: [from, { x: side * 8.5, y: HESO_SENSOR_Y - 6 }],
		material: 'pocket',
	}
}

function sidePocketWall(id: string, x: number, y: number): WallDef {
	return {
		id,
		points: [
			{ x: x - 6.6, y: y + 16 },
			{ x: x - 6.0, y: y },
			{ x: x + 6.0, y: y },
			{ x: x + 6.6, y: y + 16 },
		],
		material: 'pocket',
	}
}

// ── Windmills ──────────────────────────────────────────────────────────────

/**
 * A 20 mm six-vane wheel, and both numbers matter.
 *
 * It is *small*, so the 7.9 mm gap between vane tips will not admit an 11 mm
 * ball: the ball crosses the tips and is flicked sideways, which is what a real
 * 風車 does. The first board used a 28 mm four-vane wheel, whose 19 mm tip gaps
 * swallowed balls whole and rode them round forever — the single largest source
 * of wedged balls on it. A hub was tried first and did not help, because the
 * hub only closes the gap at the axis and the ball was never getting that far.
 *
 * They are declared before the nails because the nail placer has to know where
 * they are: anything a few millimetres off the vane tips is a press, the vane
 * driving a ball onto whatever is fixed beside it. The first board's lattice was
 * laid down with no idea the windmills existed and put a nail *inside* the swept
 * circle — and the warp scoop's outer tip reached to within 3.4 mm of it, which
 * turned out to be what was actually eating the balls blamed on the wheel.
 * `validateBoard` now checks the swept circle against everything.
 */
const windmills: WindmillDef[] = [
	{
		id: 'windmillL',
		x: -150,
		y: 292,
		blades: 6,
		tipRadius: 10,
		bladeWidth: 2.6,
		angularDamping: 0.5,
	},
	{
		id: 'windmillR',
		x: 150,
		y: 292,
		blades: 6,
		tipRadius: 10,
		bladeWidth: 2.6,
		angularDamping: 0.5,
	},
]

// ── Nails ──────────────────────────────────────────────────────────────────

const field = new NailField()

// 命釘 — the pair above the start pocket. Placed first and forced, because
// every other nail on the board is negotiable and these two are not.
const HESO_NAIL_X = HESO_GAP / 2 + NAIL_R
field.add(-HESO_NAIL_X, HESO_NAIL_Y, { force: true, hugsWall: true })
field.add(HESO_NAIL_X, HESO_NAIL_Y, { force: true, hugsWall: true })

/**
 * 寄り釘 — the gathering nails, and the approach to the start pocket.
 *
 * The temptation is to build one long solid ramp from the edge of the board
 * down to the pocket, and it does not work. A ball rolling on nails barely
 * decelerates, so it arrives at the bottom of a 130 mm ramp doing two metres a
 * second and skips straight over a 12 mm gap. Every ball is delivered and none
 * of them score.
 *
 * A real board percolates instead. Balls bounce down through open nails, losing
 * speed on every contact, and arrive above the pocket from *above*, slowly,
 * with most of their horizontal speed already gone. Only the last few
 * centimetres are a funnel.
 *
 * So: short closed shoulders around the pocket, and an open field above them
 * whose rows lean inward. The leaning is the gathering; the losing is the game.
 */

/**
 * The gathering ramp.
 *
 * Three things have to be true at once, and each of them was learned by the
 * board refusing to work without it.
 *
 * It must reach the rim. Stop it short and balls coming down the corridor
 * between the centre unit and the edge simply fall past its outer end, ride the
 * rim to the bottom and drain — the ramp is then perfectly built and never
 * touched.
 *
 * It must be solid, and it must be *dense*. Nails spaced to block an 11 mm ball
 * by half a millimetre are not a wall — a ball arriving at two metres a second
 * squeezes through. But spacing them at the ball's own width is not enough
 * either: the ball then sits in a two-millimetre notch between every adjacent
 * pair, and has to climb out of each one to move along the row. On a shallow
 * ramp it simply stops, and a third of every ball fired ends up parked on the
 * row. Packing them closer flattens the notches into something a ball rolls
 * over.
 *
 * And it must leak somewhere deliberate. With the ramp unbroken, one ball in
 * five reaches the start pocket — three times a real machine — and the hold
 * queue overflows continuously. `LEAKS` are the holes they fall through
 * instead, and their width and position are the machine's coarse payout
 * adjustment — far coarser than anything else on the board.
 *
 * Note that the 命釘 gap is *not* the throttle here, which is worth knowing
 * before spending an afternoon on it: sweeping it from 11.4 mm to 12.6 mm barely
 * moves the rate, because a ball arriving off this ramp is slow enough to drop
 * through anything it fits in. Below 11.2 mm it stops fitting and the rate falls
 * off a cliff. The gap is the fine adjustment; the leak is the coarse one.
 *
 * *Which* nails leak matters more than how many, and the response is nothing
 * like linear. Measured over 6,000 balls apiece: {6,7,8,15,16} gives a 回転率 of
 * 16.5, and simply closing index 8 — one nail, in a set of five holes — takes it
 * to 29. Index 8 sits at the point where the ramp passes the start-pocket
 * shoulder, so it is not one leak among five, it is the drain. The set below was
 * chosen by sweeping positions rather than counts.
 */
const RAMP_COUNT = 25
const LEAKS = new Set([6, 7, 8, 16])
const RAMP_TOP_Y = 196
/**
 * The outer end must sit exactly on the playfield boundary.
 *
 * Leave even a centimetre between them and the ramp is bypassed entirely: the
 * boundary curves inward as it descends, so a ball riding it drops below the
 * ramp's outer end while still outboard of everything else, and sails under the
 * whole row. The ramp then looks like a wall across the lower field and catches
 * nothing.
 */
const RAMP_TOP_X = Math.sqrt(R_INNER ** 2 - (RAMP_TOP_Y - C.y) ** 2)
/**
 * Where the ramp stops, short of the start-pocket cup.
 *
 * The gap between the ramp's last nail and the cup's outer lip is the route a
 * ball takes when it misses the 命釘, so it has to be comfortably wider than a
 * ball. At 20 it was 11.6 mm — a ball fits in and does not come out, and it is
 * the worst possible place on the board for that, a centimetre from the pocket
 * every ball is aiming at.
 */
const RAMP_INNER_X = 26
for (const s of [-1, 1]) {
	for (let i = 0; i < RAMP_COUNT; i++) {
		if (LEAKS.has(i)) continue
		const t = i / (RAMP_COUNT - 1)
		const [x, y, hugsWall] = pushOntoRail(
			s * (RAMP_TOP_X - (RAMP_TOP_X - RAMP_INNER_X) * t),
			RAMP_TOP_Y - 46 * t,
		)
		field.add(x, y, { closed: true, force: true, hugsWall })
	}
}

// A ball that skips the 命釘 lands here and is carried away from the pocket,
// rather than rattling above it until it eventually scores.
for (const s of [-1, 1]) {
	field.add(s * 36, 138, { force: true })
}

// No guard nails over the side pockets. They were tried and made things worse
// in both directions at once: they funnelled *more* balls into the mouths, and
// the space between a guard nail and a pocket wall is exactly the sort of notch
// a ball parks in for good. Narrowing the mouth is the fix; nailing around it
// is not.

// Loose nails between the ramp and the drain, so a miss still has somewhere
// interesting to go.
for (let r = 0; r < 3; r++) {
	const y = 132 - r * 16
	for (const s of [-1, 1]) {
		for (let i = 0; i < 5; i++) field.add(s * (26 + i * 26), y - i * 2)
	}
}

// 道釘 — the road nails. A shallow descending run along each flank of the
// centre unit, ferrying balls down toward the gathering row instead of letting
// them drain straight down the outside. Closed: their job is to carry.
field.row({ x: -168, y: 240 }, { x: -104, y: 196 }, 6, true)
field.row({ x: 168, y: 240 }, { x: 104, y: 196 }, 6, true)

// Right-side route. Right-hit balls come down the outer rail; these keep them
// tracking past the gate toward the two pockets.
field.add(146, 300)
field.add(133, 268)
field.add(168, 282)
field.add(158, 246)

// No nails in the right lane.
//
// Six were tried, at R_INNER + 8, to break the ball's descent. The lane is
// 19 mm wide and the ball is 11 mm, so a 2.8 mm nail anywhere in it leaves
// 6.6 mm on one side and 9.6 mm on the other: a ball fits in neither and jams
// in both. There is no position in a lane this narrow where a free-standing
// nail is not a trap, and they were the third-largest source of wedged balls.
//
// They also turned out to be unnecessary. The worry was that a ball crosses the
// attacker mouth in ten milliseconds and falls only half a millimetre in that
// time, so it could never drop in. But it does not drop in — it is thrown in.
// At three metres a second round a 215 mm rail the ball needs forty times
// gravity to hold its line, and the only thing supplying it is the rail. Take
// the rail away, which is exactly what the shutter withdrawing does, and the
// ball leaves along the tangent and straight into the pocket box.

// Upper field scatter: the chaos that makes two identical shots land
// differently.
field.lattice({ x0: -178, x1: -106, y0: 240, y1: 400 }, 27, 24)
field.lattice({ x0: -82, x1: 82, y0: 388, y1: 420 }, 26, 22)
field.lattice({ x0: 106, x1: 178, y0: 320, y1: 400 }, 27, 24)

// Lower field: gives balls that miss the 命釘 somewhere to go on their way to
// the drain, and guards the side pockets so they stay an occasional bonus.
field.lattice({ x0: -168, x1: -30, y0: 84, y1: 120 }, 30, 20)
field.lattice({ x0: 30, x1: 132, y0: 84, y1: 120 }, 30, 20)

const nails: NailDef[] = field.nails

// ── Sensors ────────────────────────────────────────────────────────────────

const attackerMid = (ATTACKER_ARC[0] + ATTACKER_ARC[1]) / 2
const denchuMid = (DENCHU_ARC[0] + DENCHU_ARC[1]) / 2
const attackerPos = polar(attackerMid, R_OUTER + POCKET_DEPTH / 2)
const denchuPos = polar(denchuMid, R_OUTER + POCKET_DEPTH / 2)
const laneMid = (R_INNER + R_OUTER) / 2
const gatePos = polar(GATE_DEG, laneMid)
const laneDrain = polar(LANE_BOTTOM_DEG + 4, laneMid)

const sensors: SensorDef[] = [
	{ id: 'heso', kind: 'heso', x: 0, y: HESO_SENSOR_Y, w: 13, h: 9 },
	{ id: 'denchu', kind: 'denchu', x: round(denchuPos.x), y: round(denchuPos.y), w: 12, h: 12 },
	{
		id: 'attacker',
		kind: 'attacker',
		x: round(attackerPos.x),
		y: round(attackerPos.y),
		w: 14,
		h: 14,
	},
	// スルー — pass-through, pays nothing, runs the tulip lottery. It sits at
	// the top of the right lane so every right-hit ball passes it on the way
	// down, which is what keeps the tulip flapping throughout support.
	{ id: 'gate', kind: 'gate', x: round(gatePos.x), y: round(gatePos.y), w: 20, h: 20 },
	// The right lane drains to the same place everything else does.
	{ id: 'outLane', kind: 'out', x: round(laneDrain.x), y: round(laneDrain.y), w: 22, h: 22 },
	{ id: 'warp', kind: 'warp', x: UNIT.left + 5, y: WARP.y, w: 12, h: 13 },
	{ id: 'sidePocketL1', kind: 'sidePocket', x: -96, y: 100, w: 11, h: 8 },
	{ id: 'sidePocketL2', kind: 'sidePocket', x: 96, y: 100, w: 11, h: 8 },
	// アウト口 — everything that reaches the bottom of the playfield.
	//
	// It has to sit clear above the drain floor's lowest point, because the
	// launch channel runs directly beneath that floor: a box drawn wide and low
	// enough to look right on paper dips through the arc and swallows every
	// ball on its way out of the hammer.
	{ id: 'out', kind: 'out', x: 0, y: 56, w: 80, h: 12 },
	// ファール口 — the foul hole, in the floor of the launch channel at its
	// lowest point, which is where a failed shot inevitably comes to rest. The
	// speed gate is what lets it live there: a ball on its way out crosses this
	// spot at well over four metres a second and flies over, while one that came
	// back is slower and drops in.
	//
	// The gate has to sit just under the slowest legal launch rather than down
	// at walking pace. Set it low and a returning ball with some speed left
	// sails past, climbs back toward the hammer, and meets the next shot
	// head-on — after which both are returning balls, and the channel jams
	// itself into a cascade that only shows up in long runs.
	{
		id: 'foul',
		kind: 'foul',
		x: round(polar(CH_FOUL_DEG, (R_INNER + R_OUTER) / 2).x),
		y: round(polar(CH_FOUL_DEG, (R_INNER + R_OUTER) / 2).y),
		w: 34,
		h: 20,
		maxSpeed: 3_800,
	},
]

// ── Movers ─────────────────────────────────────────────────────────────────

/** Mouth width of a rail notch, in millimetres. */
const arcWidth = ([a, b]: [number, number]) => ((b - a) * Math.PI * R_OUTER) / 180

const movers: MoverDef[] = [
	// The attacker shutter sits flush in the outer rail when closed, so a ball
	// running down the lane rolls straight over it; during a round it withdraws
	// and the same rolling ball falls in. Nothing about the capture is scripted
	// — the shutter is a real collider and the ball is a real ball.
	{
		id: 'attackerShutter',
		kind: 'attackerShutter',
		x: round(polar(attackerMid, R_OUTER).x),
		y: round(polar(attackerMid, R_OUTER).y),
		halfW: round(arcWidth(ATTACKER_ARC) / 2),
		halfH: 1.6,
		closedDeg: round(attackerMid + 90),
		openDeg: round(attackerMid + 90),
		closedOffset: { x: 0, y: 0 },
		openOffset: {
			x: round(Math.cos(rad(attackerMid)) * (POCKET_DEPTH + 4)),
			y: round(Math.sin(rad(attackerMid)) * (POCKET_DEPTH + 4)),
		},
	},
	// 電チュー — the tulip. Closed, the wings lie flat across the notch and the
	// lane reads as unbroken rail. Both states are real geometry, which is why
	// the tulip's open window being measured in tenths of a second matters.
	//
	// They open *outward*, into the pocket box, and that direction is not a
	// stylistic choice. A wing long enough to seal the notch is thirty
	// millimetres, and the lane is nineteen wide: swing that inward, as a tulip
	// drawn on paper does, and it sweeps clean across the lane and mashes any
	// ball there against the inner wall. That was the last wedge left on the
	// board once the drain was cleared.
	//
	// Opening outward also works for the same reason the attacker does: the ball
	// is held on its line by the rail, so removing the rail at the notch is
	// enough on its own. It leaves along the tangent, into the box. The wings do
	// not need to reach out and scoop — they only need to get out of the way.
	{
		id: 'denchuWingL',
		kind: 'denchuWing',
		side: 'left',
		x: round(polar(DENCHU_ARC[0], R_OUTER).x),
		y: round(polar(DENCHU_ARC[0], R_OUTER).y),
		halfW: round(arcWidth(DENCHU_ARC) / 2),
		halfH: 1.4,
		closedDeg: round(DENCHU_ARC[0] + 90),
		openDeg: round(DENCHU_ARC[0] + 90 - DENCHU_SWING_DEG),
	},
	{
		id: 'denchuWingR',
		kind: 'denchuWing',
		side: 'right',
		x: round(polar(DENCHU_ARC[1], R_OUTER).x),
		y: round(polar(DENCHU_ARC[1], R_OUTER).y),
		halfW: round(arcWidth(DENCHU_ARC) / 2),
		halfH: 1.4,
		closedDeg: round(DENCHU_ARC[1] - 90),
		openDeg: round(DENCHU_ARC[1] - 90 + DENCHU_SWING_DEG),
	},
]

// ── Machine spec ───────────────────────────────────────────────────────────

/**
 * A "light" modern machine.
 *
 * Real flagship machines run 1/319 with 1500-ball jackpots, which means a
 * player can sit for forty minutes and see nothing happen. That is authentic
 * and it is also untestable, so the reference board ships as the lighter class
 * of machine that really exists alongside it: roughly 1/99, short rounds, a
 * short ST. Every number here is data, so the heavy spec is a second JSON file
 * rather than a code change.
 */
/**
 * ST length, and the board's single strongest lever on return.
 *
 * Continuation compounds. At 1/49.9 a run of n spins continues with probability
 * 1 − (1 − 1/49.9)ⁿ, so the mean number of jackpots per initial hit is
 * 1/(1 − that): three at 55 spins, but only 1.8 at 30. Each jackpot is worth
 * 4.8 rounds on average and each round is ten balls at fifteen, so chain length
 * multiplies straight into the payout.
 *
 * It came down from 55 when the right-hand route was fixed. With the lane
 * sealed a right-hit ball now reaches the attacker about 95% of the time
 * instead of 57%, so rounds that used to time out part-collected take their
 * full ten balls every time: the same jackpot simply pays more. Return measured
 * 160% on the first seed after the geometry change without one line of the spec
 * having moved.
 */
const ST_SPINS = 30

const spec: MachineSpec = {
	id: 'light-99',
	name: 'P Reference Light 99',

	normalOdds: 99.9,
	stOdds: 49.9,

	// The through-gate is nearly dead in normal play and nearly certain under
	// support. That asymmetry is what makes the right side of the board
	// worthless until the machine says otherwise.
	gateOddsNormal: 60,
	gateOddsSupport: 1.02,

	jackpotVariants: [
		{
			id: '4R-ST',
			label: '4R ST',
			weight: 55,
			rounds: 4,
			st: true,
			stSpins: ST_SPINS,
			jitanSpins: 0,
		},
		{
			id: '8R-ST',
			label: '8R ST',
			weight: 20,
			rounds: 8,
			st: true,
			stSpins: ST_SPINS,
			jitanSpins: 0,
		},
		{
			id: '4R-JITAN',
			label: '4R 時短',
			weight: 25,
			rounds: 4,
			st: false,
			stSpins: 0,
			jitanSpins: 40,
		},
	],

	ballsPerRound: 10,
	roundTimeoutMs: 25_000,
	roundIntervalMs: 1_600,

	// 15 for the 大入賞口 is the value real machines almost always use, and it is
	// the right lever for the last few points of return: it scales the jackpot
	// half of the payout without touching the spin rate or the base.
	payouts: { heso: 3, denchu: 1, attacker: 15, sidePocket: 1 },

	holdCapacity: 4,
	gateHoldCapacity: 4,

	denchuOpenMsNormal: 260,
	// A short burst per gate win, not a held-open tulip. At 3.4 s the wings were
	// effectively open for the whole of ST: the hold queue overflowed 895 times
	// in an 8,000-ball run, which is the machine telling you it is feeding spins
	// faster than it can play them, and the return sat near 130%.
	denchuOpenMsSupport: 1_100,

	spinMs: { none: 4_200, nearMiss: 9_000, reach: 11_000, superReach: 22_000 },
	symbolCount: 8,
}

// ── Assemble ───────────────────────────────────────────────────────────────

const muzzle = polar(CH_MUZZLE_DEG, (R_INNER + R_OUTER) / 2)

const board: BoardFile = {
	schemaVersion: 1,
	id: 'standard-light',
	name: 'Standard Light',
	units: 'mm',
	field: { centre: C, radius: R_INNER },
	channel: {
		centre: C,
		innerRadius: R_INNER,
		outerRadius: R_OUTER,
		startDeg: CH_EXIT_DEG,
		endDeg: CH_START_DEG,
	},
	physics: {
		materials: {
			// Chrome ball on a chrome-plated nail set in a wooden board: lively,
			// but the board soaks up a lot more energy than steel-on-steel alone.
			nail: { restitution: 0.45, friction: 0.12 },
			// The rails carry the ball rather than bounce it. Give them the
			// liveliness of a wall and the ball rattles across the launch
			// channel instead of hugging its outside, reversing its spin on
			// every crossing and arriving at the top of the rail with almost
			// nothing left.
			rail: { restitution: 0.12, friction: 0.05 },
			guide: { restitution: 0.06, friction: 0.02 },
			plastic: { restitution: 0.35, friction: 0.25 },
			/**
			 * The centre unit's top cover, and the reason the handle means
			 * anything.
			 *
			 * The corridor over the unit is the route to the right lane, and a
			 * ball crossing it lands on this roof. With the frame's own lively
			 * plastic it lands on the ridge and *bounces*, and which side of the
			 * ridge it ends up on is then decided by the bounce rather than by
			 * how hard the shot was. Measured, that made the dial
			 * non-monotonic: 57% of balls reached the right lane at handle 0.55
			 * but only 11% at 0.75, so "turn it up for the right side" was false
			 * and the player's only option was to hunt for a knife-edge.
			 *
			 * A real machine's top cover is a moulded plastic shell that takes
			 * the impact dead and lets the ball run. Restitution near zero makes
			 * the landing final, so where the ball goes is set by where it
			 * lands, and where it lands is set by the handle. Low friction so it
			 * runs off promptly once it is down — this surface is a slide, not a
			 * shelf.
			 */
			cover: { restitution: 0.04, friction: 0.14 },
			// Pockets must not spit balls back out.
			pocket: { restitution: 0.1, friction: 0.4 },
			stage: { restitution: 0.05, friction: 0.3 },
		},
		ball: {
			restitution: 0.2,
			friction: 0.1,
			// The ball is loose between the board face and the glass and rubs
			// against both the whole way down. That face drag is a large part of
			// real ball behaviour and is easy to leave out by accident.
			linearDamping: 0.08,
			angularDamping: 0.2,
		},
		nailContactNoise: 5.0,
		launch: {
			muzzle: { x: round(muzzle.x), y: round(muzzle.y) },
			// Tangent to the channel at the hammer, so the ball is thrown along
			// the rail rather than into it.
			angleDeg: CH_MUZZLE_DEG - 90,
			// These two numbers place the peel-off threshold on the dial, and
			// that is all they do. `CH_EXIT_DEG` sets the *window* of arrival
			// speeds that produce a left-field shot — at 150° it spans a factor
			// of two, between the ball that cannot hold the rail as far as the
			// opening (and slides back to the foul hole) and the one that holds
			// it over the top. These decide where in the handle's travel that
			// window falls.
			//
			// Measured across the dial at 0.20 / 0.35 / 0.50 / 0.65 / 0.85, the
			// share of balls reaching the right lane runs 12 / 31 / 57 / 82 /
			// 94%. Widening the span pushes the crossover down the dial and
			// narrowing it pushes the crossover up; 6900 at the top put the
			// board fully right-hit by 0.4 and left the lower half of the
			// handle with nothing to say.
			minSpeed: 4_600,
			maxSpeed: 5_600,
			jitterSigma: 35,
		},
	},
	walls,
	arcs,
	nails,
	windmills,
	sensors,
	movers,
	stage: {
		// A shallow bowl. A ball arrives with speed, rolls up the far side,
		// comes back, and settles — the centre slot only takes it if it happens
		// to be crawling as it crosses.
		profile: [
			{ s: -55, h: 15 },
			{ s: -30, h: 4 },
			{ s: -8, h: 0.4 },
			{ s: 0, h: 0 },
			{ s: 8, h: 0.4 },
			{ s: 30, h: 4 },
			{ s: 55, h: 15 },
		],
		centreSlot: { s: 0, width: 11, maxSpeed: 190 },
		// The centre chute empties directly above the 命釘, which is why a ball
		// that finds the stage's centre slot is very nearly a guaranteed spin —
		// and therefore why the slot has to be narrow and only accept a ball
		// that is genuinely crawling. Widen it and the stage quietly becomes the
		// machine's main route to the start pocket, which is backwards: it is
		// meant to be the lucky one.
		chuteExit: { x: 0, y: UNIT.bottom - 8, vx: 0, vy: -150 },
		sideExits: [
			{ s: -55, x: -78, y: UNIT.bottom - 6, vx: -150, vy: -60 },
			{ s: 55, x: 78, y: UNIT.bottom - 6, vx: 150, vy: -60 },
		],
		drag: 0.007,
		noiseSigma: 26,
		entrySpeedScale: 0.42,
	},
	spec,
}

const out = resolve(here, '../boards/standard-light.board.json')
writeFileSync(out, `${JSON.stringify(board, null, '\t')}\n`)
console.log(
	`wrote ${out}\n  ${board.nails.length} nails, ${board.walls.length} walls, ` +
		`${board.arcs.length} arcs, ${board.sensors.length} sensors, ${board.movers.length} movers`,
)
