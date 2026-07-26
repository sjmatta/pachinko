import boardFile from '../boards/standard-light.board.json'
import { Sfx } from './audio/sfx'
import type { BoardFile } from './board/types'
import { FixedStepLoop } from './core/loop'
import { Game } from './game'
import { CompositeInput, GamepadInput, KeyboardInput, PointerInput } from './platform/input'
import { Scene } from './render/scene'
import { Hud } from './ui/hud'

/**
 * Browser entry point.
 *
 * Everything below the line — physics, machine logic, the lottery — has no idea
 * a browser exists. This file is the only place that knows about canvases,
 * pointers and requestAnimationFrame, which is what leaves an Electron shell
 * for the Steam Deck and a Capacitor shell for iOS as thin wrappers rather than
 * ports.
 */

const MAX_BALLS = 160

async function main(): Promise<void> {
	const canvas = document.querySelector<HTMLCanvasElement>('#stage')!
	const hudRoot = document.querySelector<HTMLElement>('#hud')!

	const game = await Game.create(boardFile as BoardFile, Date.now() >>> 0, 500)
	const scene = new Scene(canvas, game.board)
	const hud = new Hud(hudRoot)
	const sfx = new Sfx()

	const input = new CompositeInput([
		new PointerInput(hud.handleElement),
		new KeyboardInput(),
		new GamepadInput(),
	])

	// Audio cannot start until the player has interacted; iOS is strictest.
	for (const evt of ['pointerdown', 'keydown'] as const) {
		addEventListener(evt, () => sfx.unlock(), { once: true })
	}

	// ── Presentation subscribes; it never talks back ───────────────────────
	game.sim.events.on('nailHit', ({ speed }) => sfx.click(speed))
	game.machine.events.on('payout', () => sfx.pocket())
	game.machine.events.on('spinStart', ({ draw }) => {
		scene.lcd.startSpin(draw)
		if (draw.pattern === 'SUPER_REACH') sfx.reachSting()
	})
	game.machine.events.on('spinStop', ({ draw }) => {
		sfx.reelStop(2)
		if (draw.outcome === 'LOSE' && draw.pattern === 'NEAR_MISS') {
			scene.lcd.showBanner('おしい！', 1.2, '#7fd6ff')
		}
	})
	game.machine.events.on('jackpotStart', ({ variant }) => {
		scene.lcd.showBanner(`大当り！ ${variant.label}`, 3.4, '#ffd166')
		sfx.jackpot()
	})
	game.machine.events.on('roundStart', ({ round }) => scene.lcd.showBanner(`${round}R`, 0.9))
	game.machine.events.on('jackpotEnd', ({ totalBalls }) =>
		scene.lcd.showBanner(`${totalBalls} 玉獲得`, 2.6, '#a0ff9f'),
	)
	game.machine.events.on('modeChange', ({ mode, hitSide }) => {
		if (hitSide === 'RIGHT' && mode !== 'JACKPOT') scene.lcd.showBanner('右打ち！', 2, '#ff5d7e')
		if (mode === 'NORMAL') scene.lcd.showBanner('左打ちに戻してください', 2.2, '#7fd6ff')
	})

	// Reused every frame so the render path allocates nothing.
	const ballBuffer = new Float32Array(MAX_BALLS * 2)

	const loop = new FixedStepLoop(
		() => {
			const handle = input.poll()
			game.setHandle(handle.strength, handle.engaged)
			game.step()
		},
		(alpha, frameDt) => {
			let n = 0
			game.sim.forEachBall((id, slot) => {
				if (!slot.active || slot.onStage) return
				const p = game.sim.ballPosition(id, alpha)
				if (!p) return
				ballBuffer[n * 2] = p.x
				ballBuffer[n * 2 + 1] = p.y
				n++
			})
			scene.setBallPositions(ballBuffer, n)
			scene.setWindmillAngles(game.sim.built.windmills.map((w) => w.body.rotation()))

			for (const m of game.board.movers) {
				const t = game.sim.moverOpenness(m.id)
				if (m.kind === 'denchuWing') {
					const deg = m.closedDeg + (m.openDeg - m.closedDeg) * t
					scene.setMover(m.id, (deg * Math.PI) / 180, null)
				} else {
					const from = m.closedOffset ?? { x: 0, y: 0 }
					const to = m.openOffset ?? { x: 0, y: 0 }
					scene.setMover(m.id, null, {
						x: m.x + from.x + (to.x - from.x) * t,
						y: m.y + from.y + (to.y - from.y) * t,
					})
				}
			}

			const machine = game.machine
			scene.lcd.update(frameDt, {
				mode: machine.mode,
				hits: machine.hitSide,
				balls: machine.ledger.balance,
				spins: machine.spins,
				holds1: machine.holds.count1,
				holds2: machine.holds.count2,
				supportRemaining: machine.supportRemaining,
				round: machine.currentRound,
				roundTotal: machine.totalRounds,
				roundBalls: machine.currentRoundBalls,
				jackpotBalls: machine.currentJackpotBalls,
			})
			scene.render()
			hud.update(machine, game.sim, input.poll().strength)
		},
	)

	addEventListener('resize', () => scene.resize())
	scene.resize()
	loop.start()

	// A debug handle for the screenshot harness and for anyone who wants to see
	// a jackpot without waiting for one. Not reachable from the UI.
	;(window as unknown as { pachinko: unknown }).pachinko = { game, scene, loop }
}

main().catch((err) => {
	console.error(err)
	document.body.innerHTML = `<pre style="padding:24px;color:#ff8f9f">${String(err)}</pre>`
})
