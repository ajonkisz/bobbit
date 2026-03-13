interface AttemptRecord {
	count: number;
	windowStart: number;
}

/** Per-IP rate limiter for failed auth attempts */
export class RateLimiter {
	private attempts = new Map<string, AttemptRecord>();
	private maxAttempts: number;
	private windowMs: number;

	constructor(maxAttempts = 10, windowMs = 60_000) {
		this.maxAttempts = maxAttempts;
		this.windowMs = windowMs;
	}

	isRateLimited(ip: string): boolean {
		const record = this.attempts.get(ip);
		if (!record) return false;

		if (Date.now() - record.windowStart > this.windowMs) {
			this.attempts.delete(ip);
			return false;
		}

		return record.count >= this.maxAttempts;
	}

	recordFailure(ip: string): void {
		const now = Date.now();
		const record = this.attempts.get(ip);

		if (!record || now - record.windowStart > this.windowMs) {
			this.attempts.set(ip, { count: 1, windowStart: now });
		} else {
			record.count++;
		}
	}

	cleanup(): void {
		const now = Date.now();
		for (const [ip, record] of this.attempts) {
			if (now - record.windowStart > this.windowMs) {
				this.attempts.delete(ip);
			}
		}
	}
}
