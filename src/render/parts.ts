import * as THREE from 'three'
import { hubRadiusOf } from '../board/geometry'
import type { Board } from '../board/load'
import type { Vec2 } from '../board/types'
import { NAIL_RADIUS } from '../core/units'

/**
 * Board furniture: nails, rails, ornaments, pockets, the cabinet and the glass.
 *
 * Everything here is built once from the same board JSON the physics reads, so
 * what the player sees and what the ball collides with cannot drift apart. A
 * renderer with its own copy of the layout is a renderer that will eventually
 * show a nail that is not there.
 */

export const CHROME = new THREE.MeshStandardMaterial({
	color: 0xdfe6f0,
	metalness: 1,
	roughness: 0.18,
})

const RAIL_MAT = new THREE.MeshStandardMaterial({
	color: 0x9fb0c4,
	metalness: 0.9,
	roughness: 0.3,
})

const PLASTIC_MAT = new THREE.MeshStandardMaterial({
	color: 0x1b2740,
	metalness: 0.2,
	roughness: 0.5,
	emissive: 0x0a1830,
	emissiveIntensity: 0.6,
})

const POCKET_MAT = new THREE.MeshStandardMaterial({
	color: 0xff5d7e,
	metalness: 0.4,
	roughness: 0.35,
	emissive: 0x5a0d1e,
	emissiveIntensity: 0.9,
})

const rad = (d: number) => (d * Math.PI) / 180

/** A polyline drawn as a chain of thin boxes, so it catches the light. */
function polylineMesh(points: Vec2[], mat: THREE.Material, thickness: number, z: number) {
	const group = new THREE.Group()
	const geo = new THREE.BoxGeometry(1, thickness, thickness * 1.6)
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]!
		const b = points[i]!
		const len = Math.hypot(b.x - a.x, b.y - a.y)
		if (len < 1e-4) continue
		const seg = new THREE.Mesh(geo, mat)
		seg.scale.x = len
		seg.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, z)
		seg.rotation.z = Math.atan2(b.y - a.y, b.x - a.x)
		group.add(seg)
	}
	return group
}

export interface PlayfieldParts {
	objects: THREE.Object3D[]
	windmills: THREE.Object3D[]
	movers: Map<string, THREE.Object3D>
}

export function buildPlayfield(board: Board): PlayfieldParts {
	const objects: THREE.Object3D[] = []
	const windmills: THREE.Object3D[] = []
	const movers = new Map<string, THREE.Object3D>()

	// Board face: a dark disc the pins stand proud of.
	const face = new THREE.Mesh(
		new THREE.CircleGeometry(board.field.radius, 96),
		new THREE.MeshStandardMaterial({ color: 0x0a1020, metalness: 0.1, roughness: 0.85 }),
	)
	face.position.set(board.field.centre.x, board.field.centre.y, -0.9)
	objects.push(face)

	for (const arc of board.arcs) {
		const pts: Vec2[] = []
		const span = arc.endDeg - arc.startDeg
		for (let i = 0; i <= arc.segments; i++) {
			const deg = arc.startDeg + (span * i) / arc.segments
			pts.push({
				x: arc.centre.x + arc.radius * Math.cos(rad(deg)),
				y: arc.centre.y + arc.radius * Math.sin(rad(deg)),
			})
		}
		objects.push(polylineMesh(pts, RAIL_MAT, 0.32, 0.5))
	}
	for (const wall of board.walls) {
		const mat = wall.material === 'pocket' ? POCKET_MAT : PLASTIC_MAT
		objects.push(polylineMesh(wall.points, mat, 0.36, 0.5))
	}

	// Nails: one instanced mesh for the whole board. They are the visual
	// signature of a pachinko machine and there are a lot of them.
	const nailGeo = new THREE.CylinderGeometry(NAIL_RADIUS, NAIL_RADIUS * 0.85, 1.5, 8)
	nailGeo.rotateX(Math.PI / 2)
	const nails = new THREE.InstancedMesh(nailGeo, CHROME, board.nails.length)
	const head = new THREE.InstancedMesh(
		new THREE.SphereGeometry(NAIL_RADIUS * 1.7, 8, 6),
		CHROME,
		board.nails.length,
	)
	const dummy = new THREE.Object3D()
	board.nails.forEach((n, i) => {
		dummy.position.set(n.x, n.y, 0.4)
		dummy.updateMatrix()
		nails.setMatrixAt(i, dummy.matrix)
		dummy.position.z = 1.1
		dummy.updateMatrix()
		head.setMatrixAt(i, dummy.matrix)
	})
	objects.push(nails, head)

	// Drawn as the solid disc and rim vanes the windmill physically is, rather
	// than as a four-armed star. If the picture disagrees with the colliders the
	// player watches balls bounce off nothing.
	for (const w of board.windmills) {
		const hub = new THREE.Group()
		hub.position.set(w.x, w.y, 0.7)
		const vaneMaterial = new THREE.MeshStandardMaterial({
			color: 0x6fd3ff,
			metalness: 0.5,
			roughness: 0.3,
			emissive: 0x0a3550,
			emissiveIntensity: 1.2,
		})
		const hubRadius = hubRadiusOf(w)
		const disc = new THREE.Mesh(
			new THREE.CylinderGeometry(hubRadius, hubRadius, 0.5, 24),
			vaneMaterial,
		)
		disc.rotation.x = Math.PI / 2
		hub.add(disc)
		const vaneLength = w.tipRadius - hubRadius
		for (let i = 0; i < w.blades; i++) {
			const blade = new THREE.Mesh(
				new THREE.BoxGeometry(vaneLength, w.bladeWidth, 0.5),
				vaneMaterial,
			)
			const a = (i / w.blades) * Math.PI * 2
			const mid = hubRadius + vaneLength / 2
			blade.position.set(Math.cos(a) * mid, Math.sin(a) * mid, 0)
			blade.rotation.z = a
			hub.add(blade)
		}
		objects.push(hub)
		windmills.push(hub)
	}

	for (const m of board.movers) {
		const isWing = m.kind === 'denchuWing'
		const mesh = new THREE.Mesh(
			new THREE.BoxGeometry(m.halfW * 2, m.halfH * 2, 0.9),
			new THREE.MeshStandardMaterial({
				color: isWing ? 0xffc850 : 0x54ff9f,
				metalness: 0.5,
				roughness: 0.3,
				emissive: isWing ? 0x4a2f00 : 0x004a24,
				emissiveIntensity: 1.4,
			}),
		)
		// Rotating wings hinge at one end; the shutter is centred on its body.
		mesh.position.x = isWing ? m.halfW : 0
		const pivot = new THREE.Group()
		pivot.position.set(m.x, m.y, 0.9)
		pivot.rotation.z = rad(m.closedDeg)
		pivot.add(mesh)
		objects.push(pivot)
		movers.set(m.id, pivot)
	}

	return { objects, windmills, movers }
}

/**
 * The cabinet: the frame around the board and the glass in front of it.
 *
 * The glass is not decoration. Behind glass is how every pachinko machine has
 * ever been seen, and a specular sheet across the front is most of what
 * separates "a machine" from "some spheres on a plane".
 */
export function buildCabinet(board: Board, centre: Vec2): THREE.Object3D[] {
	const r = board.channel.outerRadius
	const frame = new THREE.Mesh(
		new THREE.TorusGeometry(r + 1.4, 1.6, 12, 96),
		new THREE.MeshStandardMaterial({
			color: 0x2a3448,
			metalness: 0.85,
			roughness: 0.28,
			emissive: 0x14324f,
			emissiveIntensity: 1.1,
		}),
	)
	frame.position.set(0, 0, 0.6)

	const glass = new THREE.Mesh(
		new THREE.CircleGeometry(r + 0.6, 96),
		new THREE.MeshPhysicalMaterial({
			transmission: 0.98,
			thickness: 0.4,
			roughness: 0.04,
			metalness: 0,
			ior: 1.5,
			transparent: true,
			opacity: 0.16,
			depthWrite: false,
		}),
	)
	glass.position.set(0, 0, 3.2)
	glass.renderOrder = 10

	const backdrop = new THREE.Mesh(
		new THREE.PlaneGeometry(r * 4, r * 4),
		new THREE.MeshStandardMaterial({ color: 0x04060c, roughness: 1 }),
	)
	backdrop.position.set(0, 0, -14)
	void centre
	return [frame, glass, backdrop]
}
