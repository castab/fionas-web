export type LiveState = 'Reconnecting' | 'Live' | 'Updates paused';
type Source = Pick<EventSource, 'close' | 'readyState'> & Pick<EventTarget, 'addEventListener'>;

export function validTimelineHint(data: unknown, inquiryId: string): boolean {
	if (typeof data !== 'string' || data.length > 512) return false;
	try {
		const value = JSON.parse(data);
		return (
			value !== null &&
			typeof value === 'object' &&
			Object.keys(value).length === 2 &&
			value.inquiryId === inquiryId.toLowerCase() &&
			typeof value.revision === 'string' &&
			/^(0|[1-9][0-9]{0,18})$/.test(value.revision)
		);
	} catch {
		return false;
	}
}

/** Per-view lifecycle; EventSource alone owns transport retries. No revision replay/dedup. */
export function timelineSubscription(options: {
	inquiryId: string;
	invalidate: () => Promise<boolean>;
	state: (state: LiveState) => void;
	create?: (url: string) => Source;
}) {
	let source: Source | null = null;
	let disposed = false;
	let terminal = false;
	let generation = 0;
	let budget: ReturnType<typeof setTimeout> | undefined;
	function stop() {
		generation++;
		clearTimeout(budget);
		budget = undefined;
		source?.close();
		source = null;
	}
	function unsynchronized() {
		options.state('Reconnecting');
		// A bounded outage budget, not a reconnect timer. Manual resume starts a new budget.
		budget ??= setTimeout(() => {
			stop();
			options.state('Updates paused');
		}, 120_000);
	}
	function resume() {
		if (disposed || terminal || source) return;
		const create =
			options.create ??
			(typeof EventSource === 'undefined' ? null : (url: string) => new EventSource(url));
		if (!create) return; // SSR
		unsynchronized();
		const current = (source = create(`/requests/${encodeURIComponent(options.inquiryId)}/updates`));
		current.addEventListener('error', () => {
			if (source !== current) return;
			generation++;
			if (current.readyState === 2) {
				terminal = true;
				stop();
				options.state('Updates paused');
			} else unsynchronized();
		});
		current.addEventListener('timeline.changed', (event) => {
			if (source !== current || !validTimelineHint((event as MessageEvent).data, options.inquiryId))
				return;
			const observed = generation;
			void options.invalidate().then((ok) => {
				if (source !== current || observed !== generation) return;
				if (ok) {
					clearTimeout(budget);
					budget = undefined;
					options.state('Live');
				} else unsynchronized();
			});
		});
	}
	return {
		resume,
		pause() {
			stop();
			options.state('Updates paused');
		},
		dispose() {
			disposed = true;
			stop();
		}
	};
}
