// Test-process-only transport fixture. Production code has no verification bypass.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
		return originalFetch(input, init);
	const body = new URLSearchParams(input instanceof Request ? await input.text() : init?.body);
	return Response.json({
		success: body.get('response') === 'e2e-turnstile-token',
		hostname: '127.0.0.1',
		action: 'booking'
	});
};
