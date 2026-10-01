/** What the visitor reads when sign-in fails. Never echoes the API's own diagnostic text. */
export function loginFailureMessage(status: number, retryAfter: number | null = null): string {
	if (status === 401) return 'That user and password don’t match — try again.';
	if (status === 429) {
		const minutes = retryAfter ? Math.max(1, Math.ceil(retryAfter / 60)) : null;
		return minutes
			? `Too many attempts — try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
			: 'Too many attempts — try again in a few minutes.';
	}
	if (status === 400 || status === 422) return 'Enter your user and password to sign in.';
	return 'Sign in is unavailable right now. Try again shortly.';
}

export const loginSuccessMessage = 'Signed in — welcome back.';
