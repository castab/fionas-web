import { env } from '$env/dynamic/private';

export function turnstileSiteKey(): string | null {
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
		return (
			typeof result === 'object' &&
			result !== null &&
			'success' in result &&
			result.success === true &&
			'hostname' in result &&
			result.hostname === hostname &&
			'action' in result &&
			result.action === 'booking'
		);
	} catch {
		return false;
	}
}
