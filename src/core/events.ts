/**
 * A tiny typed event bus.
 *
 * This is the seam that keeps the three layers apart: `sim` publishes what
 * physically happened, `machine` publishes what the machine decided, and
 * `render`/`audio`/`ui` only ever subscribe. Nothing downstream of the bus can
 * reach back and change a physical or logical outcome.
 */

export type Listener<T> = (payload: T) => void

export class Emitter<Events extends object> {
	private listeners = new Map<keyof Events, Set<Listener<never>>>()

	on<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
		let set = this.listeners.get(type)
		if (!set) {
			set = new Set()
			this.listeners.set(type, set)
		}
		set.add(fn as Listener<never>)
		return () => set.delete(fn as Listener<never>)
	}

	emit<K extends keyof Events>(type: K, payload: Events[K]): void {
		const set = this.listeners.get(type)
		if (!set) return
		for (const fn of set) (fn as Listener<Events[K]>)(payload)
	}

	clear(): void {
		this.listeners.clear()
	}
}
