import type { BackendConfig } from './backend.js';

const headers = {
	'content-type': 'text/event-stream; charset=utf-8',
	'cache-control': 'no-store, no-transform',
	'x-accel-buffering': 'no'
};
const terminal = () => new Response(null, { status: 204, headers });
// A floor even when admission ends before commerce can send its own retry directive.
const retryFrame = () => `retry: ${5000 + Math.floor(Math.random() * 2001)}\n\n`;
const retry = () => new Response(retryFrame(), { headers });

/** Separate from the JSON transport: deadline covers handshake/error classification, not SSE body. */
export async function subscribeTimeline(
	config: BackendConfig,
	inquiryId: string,
	cookie: string | null,
	signal: AbortSignal
): Promise<Response> {
	if (
		!cookie ||
		!/(?:^|;\s*)__Host-fionas_session=(?:"[^";]+"|[^;\s"]+)(?:;|$)/.test(cookie) ||
		!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(inquiryId)
	)
		return terminal();
	const abort = new AbortController();
	const disconnect = () => abort.abort();
	signal.addEventListener('abort', disconnect, { once: true });
	if (signal.aborted) abort.abort();
	const timeout = setTimeout(disconnect, 8000);
	const cleanup = () => {
		clearTimeout(timeout);
		signal.removeEventListener('abort', disconnect);
		abort.abort();
	};
	try {
		const upstream = await (config.fetch ?? fetch)(
			`${config.baseUrl.replace(/\/+$/, '')}/staff/requests/${encodeURIComponent(inquiryId)}/updates`,
			{
				method: 'GET',
				redirect: 'manual',
				signal: abort.signal,
				headers: {
					accept: 'text/event-stream',
					origin: config.origin,
					cookie,
					'accept-encoding': 'identity'
				}
			}
		);
		if (upstream.status !== 200) {
			let temporary = false;
			if (upstream.status === 503) {
				// Bound error bodies; malformed diagnostics fail closed instead of looping forever.
				const reader = upstream.body?.getReader();
				let raw = '';
				const decoder = new TextDecoder();
				if (reader) {
					try {
						while (true) {
							const chunk = await reader.read();
							if (chunk.done) break;
							raw += decoder.decode(chunk.value, { stream: true });
							if (raw.length > 8192) {
								cleanup();
								return terminal();
							}
						}
					} finally {
						await reader.cancel().catch(() => {});
					}
				}
				// Empty 503s are common ingress shutdown responses. 500/502 are deliberately
				// terminal: this contract supplies no reliable transient classification for them.
				const code: unknown = raw ? JSON.parse(raw)?.code : null;
				temporary = !raw || (typeof code === 'string' && code !== 'timeline_updates_unavailable');
			} else await upstream.body?.cancel();
			cleanup();
			return temporary ? retry() : terminal();
		}
		if (
			!/^text\/event-stream(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(
				upstream.headers.get('content-type') ?? ''
			) ||
			!upstream.body
		) {
			await upstream.body?.cancel();
			cleanup();
			return terminal();
		}
		clearTimeout(timeout);
		const reader = upstream.body.getReader();
		let cancelled = false;
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(retryFrame()));
				},
				async pull(controller) {
					try {
						const chunk = await reader.read();
						if (cancelled) return;
						if (!chunk.done) {
							controller.enqueue(chunk.value);
							return;
						}
					} catch {
						/* After commitment, clean EOF permits native reconnection. */
					}
					if (!cancelled) controller.close();
					cleanup();
					await reader.cancel().catch(() => {});
				},
				async cancel() {
					cancelled = true;
					cleanup();
					await reader.cancel().catch(() => {});
				}
			}),
			{ headers }
		);
	} catch (error) {
		cleanup();
		if (signal.aborted || error instanceof SyntaxError) return terminal();
		return retry();
	}
}
