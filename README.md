# Pachinko

A 2.5D, physics-driven simulation of a modern Japanese pachinko machine, in
TypeScript. Real ball physics, a real machine state machine, and a board whose
payout rate emerges from where its nails are rather than from a number someone
typed in.

Built to run in a browser first, with a platform-agnostic core so that a Steam
Deck build (Electron) and an iOS build (Capacitor) are thin shells rather than
ports.

```bash
npm install
npm run dev        # play it
npm test           # machine-logic tests
npm run soak       # measure the board's balance, headless
npm run board      # regenerate boards/standard-light.board.json
npm run shots      # screenshot the running game (needs `npm run dev`)
```

## The one idea the architecture is built around

On a real pachinko machine the outcome of a spin is decided **the instant a ball
trips the start-pocket sensor** — before a single reel has turned. Everything
the player then watches (the spin, the reach, the twenty-second cinematic) is a
dramatisation of a result that was already sealed into the machine.

That is reproduced literally here, and it is what shapes the whole codebase:

```
sim/       what physically happened      knows nothing about jackpots
machine/   what the machine decided      knows nothing about pixels
render/    what the player is shown      can never change a result
```

`machine/lottery.ts` runs synchronously inside the sensor callback and returns
the entire story at once: the outcome, the presentation pattern chosen to be
consistent with it, the symbols the reels will land on, and how long the show
runs. `render/lcd.ts` receives that and has no access to the random number
generator at all — it is structurally incapable of changing the result.

The same separation is what makes the machine measurable: `sim` and `machine`
both run in bare Node, so the balance harness drives the identical `Game` object
the browser does, with no renderer attached.

## What is modelled

Everything below is real machine behaviour, not an approximation of it:

- **The handle** is an analog dial, and it is the entire skill of the game. How
  far it is turned sets how hard the hammer strikes, which sets how far around
  the guide rail the ball travels before the hood at the rail exit throws it into
  the playfield. Turn it lightly and the ball drops into the left field toward
  the start pocket; turn it up and it carries over the centre unit into the right
  lane. **左打ち and 右打ち are not modes** — there is one dial, one hood, and
  ballistics.
- **Feed rate** is fixed at 100 balls a minute, as the law requires. No amount of
  enthusiasm on the handle speeds it up.
- **The foul return** catches shots too weak to make it round the rail.
- **保留** — up to four spins banked per side, with the electric-tulip side drained
  first (特図2優先消化), and overflow counted as the lost 回転 it is.
- **The through-gate** (スルー) pays nothing and runs the tulip lottery. It is
  nearly dead in normal play and nearly certain under support, which is what
  makes the right side of the board worthless until the machine says otherwise.
- **The electric tulip** (電チュー) and the **attacker** are kinematic bodies with
  real colliders. Nothing about a ball entering them is scripted: when the
  attacker's shutter is closed a ball genuinely rolls over it, and when it
  withdraws the same rolling ball genuinely falls in.
- **Rounds**: the attacker opens, pays per ball entering, and closes on a ball
  count or a timeout.
- **ST and 時短** with per-jackpot variants, so the same "you won" can mean a short
  round set and straight back to normal, or a long one followed by a chain.
- **The windmills** (風車) are free-spinning bodies on revolute joints. Residual
  spin from the previous ball is a real source of variance.
- **The centre stage** (ステージ) — see below.
- **The nails** are the payout rate. There is no fudge factor anywhere.

## Physics

Rapier2D (`@dimforge/rapier2d-compat`), fixed 240 Hz, CCD on every ball,
1 world unit = 1 cm, and real measurements throughout: an 11 mm 5.5 g ball,
2.8 mm nails, a 430 mm playfield.

Three things in `src/sim/` are worth reading before changing anything:

- **`RAPIER_LENGTH_UNIT`** (`core/units.ts`) sizes Rapier's contact tolerances to
  the ball rather than to a human-scale object. Read the parameter's name the
  other way round and set it to 100, and the tolerances balloon to about two
  millimetres — the same scale as the clearances a pachinko machine is actually
  built from. Nothing looks broken; the machine just quietly refuses to work.
- **Contact noise** is the one deliberately non-physical term. A real ball is
  loose between the board face and the glass and wobbles out of plane; a strict
  2D world has nowhere to put that, so without a small random kick at each nail
  contact, identical shots fall in eerie repeating columns. It draws from its own
  RNG stream so tuning the feel never disturbs a lottery draw.
- **The stage is a separate 1-D simulation.** A real stage is a shelf mounted
  *behind* the board plane, nearly horizontal; simulating it in the vertical
  playfield would just pull the ball straight off. It runs along the shelf's arc
  length with a gravity term from the trough profile, and a ball crossing the
  centre slot slowly enough drops through a chute directly over the start pocket.

Sensor events are drained **inside each physics step**, not once per frame: a
ball crosses the 13 mm start pocket in about five milliseconds, so polling at
frame rate silently loses entries and every balance number downstream comes out
wrong.

## Board authoring

`boards/*.board.json` is the artifact the game loads and holds everything —
geometry, sensors, movers, stage profile, machine spec. It is authored in
millimetres, because that is the unit real board drawings use and the unit nail
adjustment is discussed in, and converted to world units exactly once in
`board/load.ts`.

`tools/build-board.ts` generates it parametrically (`npm run board`), so a nail
row can be re-angled in one edit rather than by hand-writing coordinates.

`validateBoard` runs on every load and catches the mistakes that actually happen:
nails too close together to pass a ball (a wall where a route was meant), board
furniture accidentally authored **inside the launch channel** — which looks like
an ordinary lower-left coordinate but quietly swallows every ball ever fired —
and the family of ball traps described under *Wedged balls* below.

`tools/dev/board-svg.ts` draws the board and a few hundred ball tracks as an SVG.
Nail placement is a spatial problem and reading it back out of aggregate counters
is guesswork.

## Balance

`npm run soak` fires N balls at the board headless and reports the figures a real
machine is specified by. It follows the machine's own 右打ち instruction, because
firing at one fixed handle position models a player who ignores the sign and
silently destroys the return figure — ST is fed entirely from the right side of
the board.

Payout figures are per ball **paid for**, not per ball fired. A ball that fails
to clear the rail exit slides back into the foul hole and is refunded, so it was
never a shot; dividing by launches instead reads a board with a foul problem as a
board with a payout problem. One seed reported a 25% return that was really 84%,
the entire difference being 71% of shots getting their money back.

The spin rate has two traps in its definition, and getting either wrong flatters
the board by a third. **回転率 counts normal-play spins only** — spins the electric
tulip buys during ST are not what the player is spending money on. And it is per
250 balls **bought**, not launched: every ball a pocket returns gets fired again,
so a machine with a base of 30 launches about 357 balls for each 250 paid for.
Measured the loose way, this board read 14.9; measured properly it was 12.2, and
the difference was entirely ST spins and recycled balls.

Current reference board — **eight seeds × 10,000 balls**, handle 0.38 / 0.55:

| | mean of 8 seeds | real machines |
|---|---|---|
| 回転率 (spins per 250 bought) | 22.7 | 15–25 |
| start-pocket rate | 4.9% (1 in 20) | 1 in 15–20 |
| foul rate | 0.25% | low |
| stuck (watchdog) | 0.07% | 0 |
| base (returned per 100) | 30.0 | 25–35 |
| **return** | **91.3%** | 85–100% |

**Read the return figure with its spread.** Across those eight seeds it ranged
from 59% to 158%. That is not instability in the simulation — it is the ST chain,
and it is authentic: 10,000 balls contains only about six jackpots, and whether
two or three of them chain decides the whole number. The consequence for tuning
is concrete: **a single seed tells you almost nothing about return**, and the
spread is wide enough that the mean of eight is only good to roughly ±15 points.
Tune return with several seeds or not at all — and once you are inside that
error bar, stop, because further adjustment is fitting noise. The other rows are
high-count statistics, stable to within a point or two per seed, and can be tuned
from a single 6,000-ball run.

The four figures move together, which is what makes tuning a machine a loop
rather than four independent dials:

```
回転率 = 250 × (start-pocket rate) / (1 − base/100)
```

Feeding the start pocket harder raises the spin rate *and* the base — and the
base then recycles more balls, raising the spin rate again. It also multiplies
the jackpot frequency, so the payout side has to come down to compensate. Going
from 1 in 29 to 1 in 20 at the start pocket meant closing one ramp leak, halving
the 一般入賞口 payout to hold the base at 30, and cutting ST from 80 spins to 55
to hold the return.

```bash
npm run soak -- --balls 20000 --seed 7 --handle 0.38 --rightHandle 0.55
npm run soak -- --sweep handle:0.2:1.0:0.05 --balls 4000
npm run soak -- --sweep hesoGap:11.2:13.0:0.2 --balls 4000
```

Two things learned by measurement that are not obvious from a drawing, and are
documented at the code:

- The **命釘 gap is the fine adjustment, not the coarse one.** Sweeping it from
  11.4 mm to 12.6 mm barely moves the rate, because a ball arriving off the
  gathering ramp is slow enough to drop through anything it fits in. Below
  11.2 mm it stops fitting and the rate falls off a cliff. The **leaks in the
  gathering ramp** are the coarse adjustment, and they move the rate by an order
  of magnitude.
- A ramp of nails spaced at the ball's own width is not a smooth surface. The ball
  sits in a two-millimetre notch between every adjacent pair and has to climb out
  of each one, so on a shallow ramp it simply stops. Packing them closer flattens
  the notches.

## Wedged balls, and the rule that came out of it

The first version of this board lost **29% of every ball fired at it**. They did
not drain — they stopped somewhere and stayed there, and a watchdog in
`sim/world.ts` swept them up so the session stayed playable. Since a reaped ball
is a ball that never reached a pocket, every balance figure downstream was wrong.

Four separate mechanisms, and none of them visible in the JSON:

- **The side pockets dammed the drain.** Their box walls floated five
  millimetres above the drain floor, so balls sliding down from the left hit the
  underside of a wall and stopped, and the balls behind them stacked up until a
  dozen were parked in the corner. This was the biggest one, and the least
  obvious: the balls in the heap were resting on *each other*, so every
  measurement that looked for nearby board geometry found nothing.
- **The windmills were bucket wheels.** A 28 mm four-vane wheel has 19 mm gaps
  between its vane tips, so an 11 mm ball dropped in between two vanes and rode
  round in it forever. A real 風車 is small enough that the ball crosses the tips
  and never gets in. Fitting a hub does not help — the ball was never reaching
  the axis.
- **The warp hood sloped the wrong way.** Its upper surface ran down *toward* the
  centre unit's flank, so the two formed a closed V and balls rolling down the
  flank came to rest in it.
- **The tulip wings swept across the lane.** A wing long enough to seal a 30 mm
  notch is 30 mm long, and the lane is 19 mm wide: opening inward, as a tulip
  drawn on paper does, mashes any ball in the lane against the inner wall. They
  now swing 90° outward and lie flat along their own pocket box.
- **The centre unit's roof was flat**, and 160 mm of level plastic in the middle
  of the corridor is a shelf. This one hid behind a symptom that pointed
  somewhere else entirely: it presented as a **foul cascade**, one seed in four
  suddenly sending 71% of shots back down the launch channel after two thousand
  clean balls. The parked ball was nowhere near the channel — it was deflecting
  the shots that had to fly over the unit to reach the right lane. The roof is
  now pitched at 18°, comfortably past the ball-on-plastic friction angle.

The general rule, now enforced by `validateBoard` and by the generator:

> A nail standing a few millimetres off a wall is a trap. **Flush or clear** —
> nothing in between.

The instinct is to look for a slot slightly *wider* than a ball. That is the
wrong shape. Balls were measured wedged at nail-to-wall gaps of 6.8, 8.6 and
9.3 mm, every one of them narrower than the ball stuck in it. What holds the ball
is not the width of the gap, it is the corner: a V that converges downward, which
the ball rolls into from above and which nothing can then push it out of.

Two tools made this findable, and both are worth reaching for before theorising:
`tools/dev/probe.ts` bins reaped balls against *named* geometry, and Rapier's
`world.contactPairsWith` will simply tell you what a stopped ball is touching —
which is how the pile-up was finally identified after three wrong guesses.

The watchdog now distinguishes **wedged** (motionless, a hole in the board) from
**aged out** (still moving, just going nowhere), because a single number merged
the two and hid whichever was smaller.

## Targets

The core has no DOM, no three.js and no `window` beneath `src/main.ts`, which is
the only file that knows a browser exists.

- **Steam Deck** — the right analog trigger maps onto the handle directly, which
  is the closest any input gets to the real control. Electron shell, not yet built.
- **iOS** — drag the on-screen dial; the layout already respects
  `env(safe-area-inset-*)`. Capacitor shell, not yet built. Rapier's `-compat`
  build inlines its WASM as base64, so there is no fetch to fail inside a
  WKWebView.

## Not yet built

Electron and Capacitor shells, gamepad rumble and haptics, additional boards
(including a 1/319 flagship spec, which is a data file rather than code), board
artwork beyond programmer art, and the full presentation layer — story reaches,
look-ahead effects reading the hold queue, LED choreography.
