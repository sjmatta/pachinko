/**
 * The ball ledger.
 *
 * Counts are authoritative the instant a sensor trips. The tray animation
 * drains a separate queue at a plausible rate purely so balls appear to pour
 * out rather than teleport — but the animation is never the source of truth.
 * Confusing the two is how payout bugs happen.
 */
export class PayoutLedger {
	/** Balls fired onto the board. */
	launched = 0
	/** Balls awarded by pockets, total across the session. */
	paid = 0
	/** Balls sitting in the tray, available to launch. */
	balance: number

	/** Awarded but not yet visually dispensed. */
	private pending = 0
	private dispenseCarry = 0

	constructor(startingBalance: number) {
		this.balance = startingBalance
	}

	/** Take one ball from the tray to fire. Returns false if the tray is empty. */
	takeForLaunch(): boolean {
		if (this.balance <= 0) return false
		this.balance--
		this.launched++
		return true
	}

	/** A shot too weak to clear the rail comes straight back. */
	refundFoul(): void {
		this.balance++
		this.launched--
	}

	/** Award balls for a pocket entry. */
	award(count: number): void {
		if (count <= 0) return
		this.paid += count
		this.pending += count
	}

	/** Trickle awarded balls into the tray at ~`rate` balls per second. */
	dispense(dt: number, rate = 12): number {
		if (this.pending <= 0) return 0
		this.dispenseCarry += rate * dt
		const n = Math.min(Math.floor(this.dispenseCarry), this.pending)
		if (n <= 0) return 0
		this.dispenseCarry -= n
		this.pending -= n
		this.balance += n
		return n
	}

	get pendingCount(): number {
		return this.pending
	}

	/** Session profit in balls: what you have plus what you're owed, minus what you fired. */
	get net(): number {
		return this.paid - this.launched
	}
}
