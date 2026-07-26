import * as THREE from 'three'
import type { Board } from '../board/load'
import { BALL_RADIUS } from '../core/units'
import { Lcd } from './lcd'
import { buildCabinet, buildPlayfield, CHROME } from './parts'

/**
 * The 2.5D presentation.
 *
 * A pachinko board is a nearly-flat object, so the temptation is to draw it in
 * 2D and be done. What is lost is the thing that makes a real machine look the
 * way it does: the playfield is a field of chrome pins standing a centimetre
 * proud of a painted board, with a large video screen *behind* them and a sheet
 * of glass in front, and the whole assembly is lit from the frame. Nothing in
 * that reads correctly without depth.
 *
 * So the sim stays strictly planar and the renderer stacks that plane into
 * layers along z: screen at the back, board art, ornaments, nails, balls, then
 * glass. The camera is a long lens close to head-on, which keeps the board
 * reading flat and honest while still giving the pins real parallax against the
 * screen behind them.
 */

const BOARD_TILT = THREE.MathUtils.degToRad(4)

export interface RenderQuality {
	bloom: boolean
	pixelRatioCap: number
}

export class Scene {
	readonly scene = new THREE.Scene()
	readonly camera: THREE.PerspectiveCamera
	readonly renderer: THREE.WebGLRenderer
	readonly lcd: Lcd

	/** The whole machine, tilted back as one. The sim's plane is its local xy. */
	private readonly boardGroup = new THREE.Group()
	private readonly balls: THREE.InstancedMesh
	private readonly dummy = new THREE.Object3D()
	private readonly windmills: THREE.Object3D[] = []
	private readonly movers = new Map<string, THREE.Object3D>()

	constructor(
		canvas: HTMLCanvasElement,
		private readonly board: Board,
		private readonly quality: RenderQuality = { bloom: true, pixelRatioCap: 2 },
	) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pixelRatioCap))
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping
		this.renderer.toneMappingExposure = 1.15

		this.scene.background = new THREE.Color(0x05060a)
		this.camera = new THREE.PerspectiveCamera(26, 1, 1, 400)

		const centre = board.field.centre
		this.boardGroup.rotation.x = BOARD_TILT
		this.boardGroup.position.set(-centre.x, -centre.y, 0)
		this.scene.add(this.boardGroup)

		this.lcd = new Lcd(board)
		const playfield = buildPlayfield(board)
		this.boardGroup.add(this.lcd.mesh, ...playfield.objects)
		this.windmills.push(...playfield.windmills)
		for (const [id, obj] of playfield.movers) this.movers.set(id, obj)
		this.scene.add(...buildCabinet(board, centre))

		// One instanced mesh for every ball on the board. A jackpet round can
		// put a hundred of them in flight; as instances that is a single draw
		// call, so ball count is a physics cost and not a rendering one.
		this.balls = new THREE.InstancedMesh(
			new THREE.SphereGeometry(BALL_RADIUS, 16, 12),
			CHROME.clone(),
			160,
		)
		this.balls.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
		this.balls.count = 0
		this.balls.frustumCulled = false
		this.boardGroup.add(this.balls)

		this.addLights()
		this.resize()
	}

	private addLights(): void {
		const centre = this.board.field.centre
		this.scene.add(new THREE.AmbientLight(0x33405a, 1.1))
		const key = new THREE.DirectionalLight(0xffffff, 1.5)
		key.position.set(-30, 60, 60)
		this.scene.add(key)
		const fill = new THREE.PointLight(0x66aaff, 900, 200)
		fill.position.set(0, centre.y - this.board.field.radius, 30)
		this.scene.add(fill)
		// A rim light behind the pins picks out the chrome, which is most of
		// what makes a real board look metallic rather than painted.
		const rim = new THREE.DirectionalLight(0xffd9a0, 0.8)
		rim.position.set(40, -20, 20)
		this.scene.add(rim)
	}

	/** Fit the board to the viewport, whatever shape it is. */
	resize(): void {
		const canvas = this.renderer.domElement
		const w = canvas.clientWidth || 1
		const h = canvas.clientHeight || 1
		this.renderer.setSize(w, h, false)
		this.camera.aspect = w / h
		this.camera.updateProjectionMatrix()

		// Solve the camera distance from the board's radius so the machine fills
		// the shorter axis with a margin, which keeps it framed identically on a
		// 16:10 handheld and a tall phone.
		const radius = this.board.field.radius * 1.24
		const vFov = THREE.MathUtils.degToRad(this.camera.fov)
		const distV = radius / Math.tan(vFov / 2)
		const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect)
		const distH = radius / Math.tan(hFov / 2)
		this.camera.position.set(0, 0, Math.max(distV, distH))
		this.camera.lookAt(0, 0, 0)
	}

	setBallPositions(positions: Float32Array, count: number): void {
		for (let i = 0; i < count; i++) {
			this.dummy.position.set(positions[i * 2]!, positions[i * 2 + 1]!, BALL_RADIUS + 0.35)
			this.dummy.updateMatrix()
			this.balls.setMatrixAt(i, this.dummy.matrix)
		}
		this.balls.count = count
		this.balls.instanceMatrix.needsUpdate = true
	}

	setWindmillAngles(angles: number[]): void {
		this.windmills.forEach((w, i) => {
			w.rotation.z = angles[i] ?? 0
		})
	}

	/** Drive the tulip wings and attacker shutter from the sim's own state. */
	setMover(id: string, rotationRad: number | null, offset: { x: number; y: number } | null): void {
		const obj = this.movers.get(id)
		if (!obj) return
		if (rotationRad !== null) obj.rotation.z = rotationRad
		if (offset) obj.position.set(offset.x, offset.y, obj.position.z)
	}

	render(): void {
		this.lcd.flush()
		this.renderer.render(this.scene, this.camera)
	}

	get bloomEnabled(): boolean {
		return this.quality.bloom
	}
}
