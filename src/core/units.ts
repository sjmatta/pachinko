/**
 * World units.
 *
 * 1 world unit = 1 centimetre. Every dimension in this project is a real
 * measurement off a Japanese pachinko machine, converted here, so that tuning
 * numbers stay meaningful instead of drifting into arbitrary "engine units".
 */

/**
 * Rapier's `lengthUnit`, which scales its internal contact tolerances —
 * prediction distance, allowed penetration, sleep thresholds.
 *
 * It wants **the size of a typical dynamic object, in world units**, not the
 * number of units in a metre. Reading it the other way and setting 100 is a
 * trap worth naming, because it does not look like a physics bug when it
 * happens: the tolerances balloon to about two millimetres, which is the same
 * scale as the clearances a pachinko machine is actually built from. The ball
 * then behaves as though permanently in contact with both walls of a 19 mm
 * launch channel, rattles between them shedding spin, and arrives at the top
 * of the rail with a tenth of the energy it left with. Nothing reads as
 * obviously broken — the machine just quietly refuses to work.
 *
 * The ball is 1.1 units across, so that is the number.
 */
export const RAPIER_LENGTH_UNIT = 1.1

/** Convert millimetres to world units. */
export const mm = (v: number): number => v / 10

/** Convert centimetres to world units (identity, kept for readability). */
export const cm = (v: number): number => v

/** Gravity, in world units per second squared (9.81 m/s²). */
export const GRAVITY = -981

/** Pachinko ball: 11 mm diameter, 5.5 g chrome-plated steel. */
export const BALL_RADIUS = mm(11) / 2
export const BALL_MASS_G = 5.5

/**
 * Nail (釘) radius. Real board nails are a shade under 3 mm across the shank.
 * They are the entire game: their placement decides how often a ball reaches
 * the start pocket, and therefore the machine's payout rate.
 */
export const NAIL_RADIUS = mm(2.8) / 2

/** Playfield (盤面) is a disc roughly 430 mm across behind the glass. */
export const BOARD_RADIUS = cm(21.5)
export const BOARD_CENTRE_Y = cm(24)

/** Balls are fed to the launcher at a fixed cadence: 100 per minute. */
export const FEED_INTERVAL_S = 0.6

/** Physics runs at a fixed 240 Hz; the renderer interpolates between states. */
export const SIM_HZ = 240
export const SIM_DT = 1 / SIM_HZ
