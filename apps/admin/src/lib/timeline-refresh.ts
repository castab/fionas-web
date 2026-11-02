/** One serialized read loop for manual refresh and invalidation hints. */
export function timelineRefresh<T>(options: {
	read: (signal: AbortSignal) => Promise<T>;
	apply: (value: T) => void;
	busy: (value: boolean) => void;
	failure: (manual: boolean) => void;
}) {
	let disposed = false;
	let pending = false;
	let manual = false;
	let running: Promise<boolean> | null = null;
	const abort = new AbortController();
	async function run() {
		options.busy(true);
		let succeeded = false;
		try {
			while (pending && !disposed) {
				pending = false;
				const report = manual;
				manual = false;
				try {
					const value = await options.read(abort.signal);
					if (disposed) return false;
					options.apply(value);
					succeeded = true;
				} catch {
					succeeded = false;
					if (!disposed) options.failure(report);
				}
			}
			return succeeded;
		} finally {
			running = null;
			if (!disposed) options.busy(false);
		}
	}
	return {
		request(isManual = false) {
			if (disposed) return Promise.resolve(false);
			pending = true;
			manual ||= isManual;
			// Microtask coalesces bursts; hints during the read set pending for another pass.
			return (running ??= Promise.resolve().then(run));
		},
		dispose() {
			disposed = true;
			abort.abort();
		}
	};
}
