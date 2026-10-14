import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';

// Cloudflare's published always-pass pair returns fixed metadata, not the widget's host/action.
const isTestPair = () =>
	env.TURNSTILE_SITE_KEY?.trim() === '1x00000000000000000000AA' &&
	env.TURNSTILE_SECRET_KEY?.trim() === '1x0000000000000000000000000000000AA';

export function turnstileSiteKey(): string | null {
	if (!dev && isTestPair()) return null;
	return env.TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET_KEY?.trim()
		? env.TURNSTILE_SITE_KEY.trim()
		: null;
}

/** Fail closed; never log tokens, secrets, responses or transport errors. */
export async function verifyTurnstile(
	data: FormData,
	hostname: string,
	fetcher: typeof fetch
): Promise<boolean> {
	const tokens = data.getAll('cf-turnstile-response');
	const token = tokens[0];
	if (
		!turnstileSiteKey() ||
		tokens.length !== 1 ||
		typeof token !== 'string' ||
		!token.trim() ||
		token.length > 2048
	)
		return false;
	try {
		const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY!.trim(), response: token }),
			signal: AbortSignal.timeout(10_000)
		});
		if (!response.ok) return false;
		const result: unknown = await response.json();
		if (
			typeof result !== 'object' ||
			result === null ||
			!('success' in result) ||
			result.success !== true
		)
			return false;
		// Still call Siteverify: a widget callback or a dummy-looking token alone is never enough.
		if (dev && isTestPair() && token === 'XXXX.DUMMY.TOKEN.XXXX') return true;
		return (
			'hostname' in result &&
			result.hostname === hostname &&
			'action' in result &&
			result.action === 'booking'
		);
	} catch {
		return false;
	}
}
