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
import type {
	ArcDef,
	BoardFile,
	MoverDef,
	NailDef,
	SensorDef,
	Vec2,
	WallDef,
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
const CH_EXIT_DEG = 105
/**
 * The right lane (右打ちルート).
 *
 * A second annular channel, this one between the playfield's edge and the outer
 * rail on the right-hand side. A shot hard enough to carry the ball right over
 * the top of the board drops it in here at 354°, and from there it runs
 * downhill past the through-gate, the tulip and the attacker before draining.
 *
 * This is the whole of "right-hit". There is no mode switch and no teleport —
 * the machine simply tells the player to turn the handle further, and the
 * board's geometry does the rest. Left-hitting during a jackpot misses the
 * attacker entirely, and right-hitting during normal play misses the start
 * pocket, both for the same purely physical reason.
 *
 * The pockets are notches in the *outer* rail rather than the inner wall,
 * because a ball running down a curve is thrown against the outside of it: a
 * pocket on the inner wall would almost never catch anything.
 */
const LANE_TOP_DEG = 354
const LANE_BOTTOM_DEG = CH_START_DEG
const GATE_DEG = 344
const ATTACKER_ARC: [number, number] = [303, 317]
const DENCHU_ARC: [number, number] = [324, 332]
/** How far the pocket boxes stand proud of the outer rail. */
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

	add(x: number, y: number, opts: { closed?: boolean; force?: boolean } = {}): NailDef | null {
		if (!opts.force && (!inField(x, y) || !clearOfUnit(x, y))) return null
		if (!opts.force && this.tooClose(x, y, opts.closed ?? false)) return null
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
		segments: 200,
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
		segments: 110,
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
		endDeg: LANE_TOP_DEG,
		segments: 30,
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
			{ x: UNIT.right - 16, y: UNIT.top },
			{ x: UNIT.left + 16, y: UNIT.top },
			{ x: UNIT.left, y: UNIT.top - 16 },
			{ x: UNIT.left, y: WARP.y + WARP.h / 2 },
		],
		material: 'plastic',
	},
	// A hood over the warp mouth. Without it every ball sliding down the unit's
	// left face drops straight in and a fifth of the board ends up on the
	// stage; a real warp takes a few percent. The ball now has to arrive on an
	// upward bounce to get under the hood, which is what makes finding it feel
	// like luck rather than routing.
	{
		id: 'warpHood',
		points: [
			{ x: UNIT.left - 9, y: WARP.y + WARP.h / 2 + 4 },
			{ x: UNIT.left - 3, y: WARP.y + WARP.h / 2 + 1 },
			{ x: UNIT.left, y: WARP.y + WARP.h / 2 },
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
	{
		id: 'hesoCupLeft',
		points: [
			{ x: -15, y: HESO_NAIL_Y - 4 },
			{ x: -7.5, y: HESO_SENSOR_Y - 6 },
		],
		material: 'pocket',
	},
	{
		id: 'hesoCupRight',
		points: [
			{ x: 15, y: HESO_NAIL_Y - 4 },
			{ x: 7.5, y: HESO_SENSOR_Y - 6 },
		],
		material: 'pocket',
	},

	/**
	 * 返し — the hood over the rail exit, and the single most important piece
	 * of geometry on the board after the start pocket itself.
	 *
	 * Left to itself a ball leaving the channel is still travelling tangentially
	 * inside the outer rail, and at any speed worth firing it needs several g of
	 * centripetal force to turn — which the rail happily supplies. So it simply
	 * keeps going round, and every shot at every handle position ends up in the
	 * right lane. The handle stops meaning anything.
	 *
	 * The hood turns the ball off the rail and throws it down and to the right
	 * into the playfield. From there its speed decides everything: a trickle
	 * drops into the left field toward the start pocket, while a hard shot
	 * carries over the centre unit and into the right lane. That is the whole
	 * of 左打ち and 右打ち — one dial, one hood, and ballistics.
	 *
	 * It doubles as the return-prevention flap: a ball falling back cannot get
	 * into the mouth it came out of.
	 */
	{
		id: 'railExitHood',
		// It must meet the outer rail exactly at the exit angle and only turn
		// inward beyond it. Start it a degree early and it reaches back across
		// the channel, walls off the mouth, and every shot fouls.
		// How far it reaches is the handle's whole dynamic range. A long hood
		// turns every shot hard down-left and the dial stops mattering; a short
		// one barely turns the ball at all and everything reaches the right
		// lane. This length leaves a weak shot dropping into the left field and
		// a hard one still carrying enough to cross the board.
		points: [
			polar(CH_EXIT_DEG, R_OUTER),
			polar(CH_EXIT_DEG - 4, R_OUTER - 5),
			polar(CH_EXIT_DEG - 9, R_OUTER - 11),
			polar(CH_EXIT_DEG - 14, R_OUTER - 17),
		],
		material: 'guide',
	},

	// 一般入賞口 — side pockets. They pay but never spin, and they are most of
	// what keeps the base rate up during ordinary play. Both sit on the left,
	// because the left is the normal-play route: the right side of the board
	// belongs to the tulip and the attacker.
	sidePocketWall('sideL1', -96, 78),
	sidePocketWall('sideL2', 96, 78),
]

/**
 * A pocket mouth barely wider than a ball, with near-vertical walls.
 *
 * The flared lead-in that looks right on paper is the problem: a 26 mm funnel
 * anywhere in the lower field catches close to half of everything fired, and at
 * three balls a time that alone puts the machine near 180% return. Guarding it
 * with nails does not help — they funnel too. The mouth itself has to be the
 * width of a ball and no more.
 */
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

// ── Nails ──────────────────────────────────────────────────────────────────

const field = new NailField()

// 命釘 — the pair above the start pocket. Placed first and forced, because
// every other nail on the board is negotiable and these two are not.
const HESO_NAIL_X = HESO_GAP / 2 + NAIL_R
field.add(-HESO_NAIL_X, HESO_NAIL_Y, { force: true })
field.add(HESO_NAIL_X, HESO_NAIL_Y, { force: true })

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
 */
const RAMP_COUNT = 25
const LEAKS = new Set([6, 7, 8, 15, 16])
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
for (const s of [-1, 1]) {
	for (let i = 0; i < RAMP_COUNT; i++) {
		if (LEAKS.has(i)) continue
		const t = i / (RAMP_COUNT - 1)
		field.add(s * (RAMP_TOP_X - (RAMP_TOP_X - 20) * t), RAMP_TOP_Y - 46 * t, {
			closed: true,
			force: true,
		})
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

// Nails in the right lane itself, to break the ball's descent.
//
// Without them a ball arrives at the attacker doing three metres a second and
// is thrown against the outer rail by the curve, so it crosses a thirty-
// millimetre open mouth in ten milliseconds and falls half a millimetre. It
// sails over the pocket every time, and a jackpot pays out nothing at all while
// the round counter runs happily to completion.
for (const deg of [349, 341, 334, 327, 320, 312]) {
	const p = polar(deg, R_INNER + 8)
	field.add(p.x, p.y, { force: true })
}

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
	{ id: 'sidePocketL1', kind: 'sidePocket', x: -96, y: 74, w: 11, h: 8 },
	{ id: 'sidePocketL2', kind: 'sidePocket', x: 96, y: 74, w: 11, h: 8 },
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
	// lane reads as unbroken rail; open, they stand up into the lane and scoop
	// balls in. Both states are real geometry, which is why the tulip's open
	// window being measured in tenths of a second actually matters.
	{
		id: 'denchuWingL',
		kind: 'denchuWing',
		side: 'left',
		x: round(polar(DENCHU_ARC[0], R_OUTER).x),
		y: round(polar(DENCHU_ARC[0], R_OUTER).y),
		halfW: round(arcWidth(DENCHU_ARC) / 2),
		halfH: 1.4,
		closedDeg: round(DENCHU_ARC[0] + 90),
		openDeg: round(DENCHU_ARC[0] + 152),
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
		openDeg: round(DENCHU_ARC[1] - 152),
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
			stSpins: 60,
			jitanSpins: 0,
		},
		{
			id: '8R-ST',
			label: '8R ST',
			weight: 20,
			rounds: 8,
			st: true,
			stSpins: 60,
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

	ballsPerRound: 9,
	roundTimeoutMs: 25_000,
	roundIntervalMs: 1_600,

	payouts: { heso: 3, denchu: 2, attacker: 14, sidePocket: 2 },

	holdCapacity: 4,
	gateHoldCapacity: 4,

	denchuOpenMsNormal: 260,
	denchuOpenMsSupport: 3_400,

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
			// Clearing the rail exit costs about 5.0 m/s, and whatever is left
			// over decides everything. A ball arriving at the exit with a
			// trickle drops straight into the left field toward the start
			// pocket; one arriving with 4 m/s still in hand has more than
			// enough to hold the outer rail all the way over the top and down
			// into the right lane.
			//
			// So the entire useful range of the handle is the narrow band
			// between those two, and the dial is correspondingly touchy. That
			// is not a tuning failure — it is why real players agonise over a
			// few degrees of handle position and mark it with a rubber band.
			minSpeed: 4_650,
			maxSpeed: 6_900,
			jitterSigma: 35,
		},
	},
	walls,
	arcs,
	nails,
	windmills: [
		{
			id: 'windmillL',
			x: -128,
			y: 248,
			blades: 4,
			tipRadius: 14,
			bladeWidth: 2.6,
			angularDamping: 0.8,
		},
		{
			id: 'windmillR',
			x: 128,
			y: 248,
			blades: 4,
			tipRadius: 14,
			bladeWidth: 2.6,
			angularDamping: 0.8,
		},
	],
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
