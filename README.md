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

`validateBoard` runs on every load and catches the two mistakes that actually
happen: nails too close together to pass a ball (a wall where a route was meant),
and board furniture accidentally authored **inside the launch channel** — which
looks like an ordinary lower-left coordinate but quietly swallows every ball ever
fired.

`tools/dev/board-svg.ts` draws the board and a few hundred ball tracks as an SVG.
Nail placement is a spatial problem and reading it back out of aggregate counters
is guesswork.

## Balance

`npm run soak` fires N balls at the board headless and reports the figures a real
machine is specified by. It follows the machine's own 右打ち instruction, because
firing at one fixed handle position models a player who ignores the sign and
silently destroys the return figure — ST is fed entirely from the right side of
the board.

Current reference board, 10,000 balls, seed 33, handle 0.40 / 0.55:

| | measured | real machines |
|---|---|---|
| spins per 250 balls | 12.9 | 15–25 |
| start-pocket rate | 4.2% (1 in 24) | ~1 in 15 |
| warp rate | 1.9% | 3–8% |
| foul rate | 0.9% | low |
| base (returned per 100) | 69 | 25–35 |
| **return** | **99.2%** | 85–100% |

Net over ten thousand balls: **+10**. The return and the foul rate are where they
should be; the spin rate is a little low and the base a little high, both of which
are nail-placement work rather than code.

```bash
npm run soak -- --balls 20000 --seed 7 --handle 0.4 --rightHandle 0.55
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

### Known defect

About a quarter of balls still wedge somewhere on the board and are drained by
the watchdog in `sim/world.ts` (`stuck` in the soak report). The watchdog keeps
the pool healthy and the session playable, but every reaped ball is a ball that
should have reached a pocket, and it is suppressing the spin rate. This is board
geometry, not engine behaviour. `tools/dev/probe.ts` reports where they stop.

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
