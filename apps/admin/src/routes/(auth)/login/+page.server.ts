import { fail, redirect } from '@sveltejs/kit';
import { loginFailureMessage } from '$lib/login.js';
import { applySetCookies, login } from '$lib/server/auth.js';
import { backendConfig } from '$lib/server/config.js';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async ({ request, url, cookies }) => {
		const data = await request.formData();
		const username = String(data.get('username') ?? '').trim();
		const password = String(data.get('password') ?? '');

		if (!username || !password) {
			return fail(422, { username, formError: loginFailureMessage(422) });
		}

		const result = await login(backendConfig(url.origin), { username, password });
		if (!result.ok) {
			return fail(result.status >= 500 ? 503 : result.status, {
				username,
				formError: loginFailureMessage(result.status, result.retryAfter)
			});
		}

		// The API's session cookie is host-only for the API, so re-issue it on this site.
		applySetCookies(cookies, result.setCookies);
		redirect(303, '/');
	}
};
