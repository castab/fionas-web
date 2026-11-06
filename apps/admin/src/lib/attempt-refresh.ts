import { timelineRefresh } from './timeline-refresh.js';

/**
 * Customer payments' attempt refresh: one serialized read loop (the timeline's
 * `timelineRefresh`), so overlapping live notifications coalesce and a hint that arrives during a
 * read schedules another pass instead of being dropped. Reads go to the admin's read-only
 * `/requests/{id}/customer-payments` endpoint; nothing here calls Stripe or polls.
 *
 * A deliberate action (a reconcile answer with its own re-listed attempts) is newer than any read
 * already in flight: `local()` marks it, and a read that started before it is discarded and read
 * again rather than allowed to overwrite it. `basis` is whatever the caller captured when the read
 * started (the staff-request snapshot it pairs with), handed back with the value.
 */
export function attemptRefresh<T, B>(options: {
	read: (signal: AbortSignal) => Promise<T>;
	/** Captured when each read starts. */
	basis: () => B;
	apply: (value: T, basis: B) => void;
	busy: (value: boolean) => void;
	/** The last applied value stays; the caller says it may be out of date. */
	failure: () => void;
}) {
	let generation = 0;
	const loop = timelineRefresh<{ value: T; basis: B; generation: number }>({
		async read(signal) {
			const started = generation;
			const basis = options.basis();
			return { value: await options.read(signal), basis, generation: started };
		},
		apply(result) {
			// Superseded by a newer local answer: read again rather than apply an older one.
			if (result.generation !== generation) void loop.request();
			else options.apply(result.value, result.basis);
		},
		busy: options.busy,
		failure: () => options.failure()
	});
	return {
		/** Ask for a read; resolves true when the loop ended on a successful apply. */
		request: () => loop.request(),
		/** A newer authoritative value was applied outside this loop. */
		local() {
			generation++;
		},
		dispose: () => loop.dispose()
	};
}
