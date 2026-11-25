import { fail } from '@sveltejs/kit';
import { passwordChangeFailureMessage, passwordChangeProblem } from '$lib/passkeys.js';
import { changePassword, readStaffAccount } from '$lib/server/account.js';
import { applySetCookies } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import { listPasskeys } from '$lib/server/passkeys.js';
import type { Actions, PageServerLoad } from './$types';

/** The staff member's profile and passkeys. Either read may fail on its own. */
export const load: PageServerLoad = async ({ request, url, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store' });
	const config = backendConfig(url.origin);
	const cookie = request.headers.get('cookie');
	const [account, passkeys] = await Promise.all([
		readStaffAccount(config, cookie),
		listPasskeys(config, cookie)
	]);
	return {
		account: account.ok ? account.data : null,
		passkeys: passkeys.ok ? passkeys.data : null
	};
};

export const actions: Actions = {
	/**
	 * Changes the staff member's own password. Commerce checks the current one, signs out every
	 * other session and answers with a fresh session cookie for this browser. Passwords are never
	 * echoed back into the form.
	 */
	password: async ({ request, url, cookies }) => {
		const data = await request.formData();
		const input = {
			currentPassword: String(data.get('currentPassword') ?? ''),
			newPassword: String(data.get('newPassword') ?? ''),
			confirmPassword: String(data.get('confirmPassword') ?? '')
		};
		const problem = passwordChangeProblem(input);
		if (problem) return fail(422, { password: { field: problem.field, error: problem.message } });

		const result = await changePassword(backendConfig(url.origin), request.headers.get('cookie'), {
			currentPassword: input.currentPassword,
			newPassword: input.newPassword
		});
		if (!result.ok) {
			const error = passwordChangeFailureMessage(result.status, result.code, result.retryAfter);
			const field = result.status === 401 ? ('current' as const) : null;
			return fail(result.status >= 500 ? 503 : result.status, { password: { field, error } });
		}
		applySetCookies(cookies, result.setCookies);
		return { password: { changed: true as const } };
	}
};
