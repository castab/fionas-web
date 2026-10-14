import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dev: true, env: {} as Record<string, string> }));
vi.mock('$env/dynamic/private', () => ({ env: state.env }));
vi.mock('$app/environment', () => ({
	get dev() {
		return state.dev;
	}
}));
import { turnstileSiteKey, verifyTurnstile } from './turnstile.js';

const fetcher = vi.fn<typeof fetch>();
function form(token = 'XXXX.DUMMY.TOKEN.XXXX') {
	const data = new FormData();
	data.set('cf-turnstile-response', token);
	return data;
}
beforeEach(() => {
	state.dev = true;
	state.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
	state.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
	fetcher
		.mockReset()
		.mockImplementation(async () => Response.json({ success: true, hostname: 'example.com' }));
});

it.each(['localhost', '127.0.0.1'])(
	'accepts Cloudflare-verified dummy metadata on the dev server at %s',
	async (hostname) => {
		expect(await verifyTurnstile(form(), hostname, fetcher)).toBe(true);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0][0]).toBe(
			'https://challenges.cloudflare.com/turnstile/v0/siteverify'
		);
	}
);

it.each(['rejected', 'network', 'http', 'malformed'])(
	'still refuses a development challenge on %s verification',
	async (mode) => {
		if (mode === 'rejected') fetcher.mockResolvedValue(Response.json({ success: false }));
		if (mode === 'network') fetcher.mockRejectedValue(new Error('offline'));
		if (mode === 'http') fetcher.mockResolvedValue(new Response('', { status: 503 }));
		if (mode === 'malformed') fetcher.mockResolvedValue(Response.json(null));
		expect(await verifyTurnstile(form(), 'localhost', fetcher)).toBe(false);
	}
);

it('never offers or accepts the always-pass test pair in a production build', async () => {
	state.dev = false;
	expect(turnstileSiteKey()).toBeNull();
	expect(await verifyTurnstile(form(), 'example.com', fetcher)).toBe(false);
	expect(fetcher).not.toHaveBeenCalled();
});

it.each(['site-key', 'secret-key', 'token'])(
	'does not relax metadata checks with a different %s',
	async (changed) => {
		if (changed === 'site-key') state.env.TURNSTILE_SITE_KEY = 'real-site-key';
		if (changed === 'secret-key') state.env.TURNSTILE_SECRET_KEY = 'real-secret-key';
		expect(
			await verifyTurnstile(
				form(changed === 'token' ? 'other-token' : undefined),
				'localhost',
				fetcher
			)
		).toBe(false);
	}
);

it.each([true, false])('requires matching host and action with real keys, dev=%s', async (dev) => {
	state.dev = dev;
	state.env.TURNSTILE_SITE_KEY = 'real-site-key';
	state.env.TURNSTILE_SECRET_KEY = 'real-secret-key';
	for (const result of [
		{ success: true, hostname: 'other.example', action: 'booking' },
		{ success: true, hostname: 'fionas.example', action: 'login' }
	]) {
		fetcher.mockResolvedValueOnce(Response.json(result));
		expect(await verifyTurnstile(form('real-token'), 'fionas.example', fetcher)).toBe(false);
	}
	fetcher.mockResolvedValueOnce(
		Response.json({ success: true, hostname: 'fionas.example', action: 'booking' })
	);
	expect(await verifyTurnstile(form('real-token'), 'fionas.example', fetcher)).toBe(true);
});
