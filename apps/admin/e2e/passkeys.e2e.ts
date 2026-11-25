import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type CDPSession, type Page } from '@playwright/test';

// WebAuthn never accepts an IP address as its RP ID, so these specs use the second admin server
// on localhost (playwright.config.ts). The stub verifies every ceremony against the virtual
// authenticator's real keys (e2e/passkey-stub.mjs).
const origin = `http://localhost:${process.env.ADMIN_PASSKEY_PORT ?? '4175'}`;
const stubUrl = `http://127.0.0.1:${process.env.ADMIN_STUB_PORT ?? '4176'}`;
const password = 'e2e-password';

test.use({ baseURL: origin });

type Authenticator = { cdp: CDPSession; authenticatorId: string };

/** A Chromium CDP virtual authenticator: CTAP2, built in, resident keys, user verification. */
async function addAuthenticator(page: Page): Promise<Authenticator> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});
	return { cdp, authenticatorId };
}

async function storedCredentials({ cdp, authenticatorId }: Authenticator) {
	return (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
}

/**
 * Records the signal API calls, and makes the post-sign-in nudge deterministic: no automatic
 * passkey upgrade, so it always shows its prompt. A virtual authenticator answers a conditional
 * (autofill) request at once, as if the person picked the passkey, so autofill is off unless a
 * test asks for it.
 */
async function instrument(page: Page, { autofill = false, upgrade = false } = {}) {
	await page.addInitScript(
		({ autofill, upgrade }) => {
			const w = window as unknown as { __signals: unknown[] };
			w.__signals = [];
			const pkc = window.PublicKeyCredential as unknown as Record<string, unknown>;
			if (!pkc) return;
			pkc.getClientCapabilities = async () => ({
				conditionalCreate: upgrade,
				conditionalGet: true
			});
			pkc.signalUnknownCredential = async (options: unknown) => {
				w.__signals.push({ unknown: options });
			};
			pkc.signalAllAcceptedCredentials = async (options: unknown) => {
				w.__signals.push({ accepted: options });
			};
			if (!autofill) pkc.isConditionalMediationAvailable = async () => false;
		},
		{ autofill, upgrade }
	);
}

const signals = (page: Page) =>
	page.evaluate(() => (window as unknown as { __signals: Record<string, unknown>[] }).__signals);

const newUsername = () => `passkey-${randomUUID().slice(0, 8)}`;

async function signInWithPassword(page: Page, username: string, pass = password) {
	await page.goto('/login');
	await page.getByLabel('User').fill(username);
	await page.getByLabel('Password').fill(pass);
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page).toHaveURL(`${origin}/`);
}

async function signOut(page: Page, isMobile: boolean) {
	if (isMobile) await page.getByLabel('Your account').click();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);
}

async function stub(context: BrowserContext, body?: Record<string, unknown>) {
	const cookie = (await context.cookies(origin))
		.filter(({ name }) => name === '__Host-fionas_session')
		.map(({ name, value }) => `${name}=${value}`)
		.join('; ');
	const response = body
		? await context.request.post(`${stubUrl}/__test/account`, { headers: { cookie }, data: body })
		: await context.request.get(`${stubUrl}/__test/account`, { headers: { cookie } });
	expect(response.ok()).toBe(true);
	return body ? null : response.json();
}

async function createPasskeyInSettings(page: Page, authenticator: Authenticator) {
	await page.goto('/settings/account');
	const before = (await storedCredentials(authenticator)).length;
	await page.getByRole('button', { name: 'Create a passkey' }).click();
	await expect(page.getByTestId('passkey')).toHaveCount(before + 1);
	expect(await storedCredentials(authenticator)).toHaveLength(before + 1);
}

test('create a passkey in Account settings, sign out, then sign in with it', async ({
	page,
	context,
	isMobile
}) => {
	await instrument(page);
	const authenticator = await addAuthenticator(page);
	const username = newUsername();
	await signInWithPassword(page, username);

	await page.goto('/settings/account');
	await expect(page).toHaveTitle("Account settings · Admin · Fiona's Ice Cream");
	const profile = page.getByTestId('profile');
	await expect(profile).toContainText('Passkey Tester');
	await expect(profile).toContainText(`@${username}`);
	await expect(profile).toContainText('Administrator');
	await expect(page.getByTestId('no-passkeys')).toContainText('fingerprint, face, or screen lock');

	await page.getByRole('button', { name: 'Create a passkey' }).click();
	const row = page.getByTestId('passkey');
	await expect(row).toHaveCount(1);
	await expect(row).toContainText('Not used yet');
	const [credential] = await storedCredentials(authenticator);
	expect(credential.isResidentCredential).toBe(true);
	const account = await stub(context);
	expect(account.passkeys).toHaveLength(1);
	// Commerce receives the ceremony id from the admin server; the browser never holds it.
	const ceremony = (await context.cookies(origin)).find((c) => c.name === '__Host-fionas_webauthn');
	expect(ceremony).toBeUndefined();

	await signOut(page, isMobile);
	await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
	await expect(page).toHaveURL(`${origin}/`);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('hi, passkey');
	// A passkey sign-in never prompts for a passkey.
	await expect(page.getByTestId('passkey-nudge')).toHaveCount(0);

	await page.goto('/settings/account');
	await expect(page.getByTestId('passkey')).toContainText('Last used');
});

test('rename and remove a passkey', async ({ page }) => {
	await instrument(page);
	const authenticator = await addAuthenticator(page);
	const username = newUsername();
	await signInWithPassword(page, username);
	await createPasskeyInSettings(page, authenticator);
	// This authenticator already holds one: excludeCredentials makes the browser refuse another.
	await page.getByRole('button', { name: 'Create a passkey' }).click();
	await expect(page.getByTestId('create-error')).toHaveText(
		'This device or password manager already has a passkey for your account.'
	);
	await expect(page.getByTestId('passkey')).toHaveCount(1);

	await page.getByRole('button', { name: 'Rename Passkey' }).click();
	await page.getByLabel('Passkey name').fill('  Work   laptop ');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByTestId('passkey-name')).toHaveText('Work laptop');
	await page.reload();
	await expect(page.getByTestId('passkey-name')).toHaveText('Work laptop');

	await page.getByRole('button', { name: 'Remove Work laptop' }).click();
	const dialog = page.getByRole('dialog', { name: 'Remove this passkey?' });
	await expect(dialog).toContainText('It’s your only passkey. You’ll sign in with your password.');
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId('passkey')).toHaveCount(1);

	await page.getByRole('button', { name: 'Remove Work laptop' }).click();
	await page.getByRole('button', { name: 'Remove passkey' }).click();
	await expect(page.getByTestId('no-passkeys')).toBeVisible();
	const { userHandle } = await stub(page.context());
	// Password managers hear that this account accepts no passkeys any more.
	expect(await signals(page)).toContainEqual({
		accepted: { rpId: 'localhost', userId: userHandle, allAcceptedCredentialIds: [] }
	});
});

test('after ten minutes, removing a passkey asks to confirm it’s you, then retries', async ({
	page,
	context
}) => {
	await instrument(page);
	const authenticator = await addAuthenticator(page);
	await signInWithPassword(page, newUsername());
	await createPasskeyInSettings(page, authenticator);
	await stub(context, { sudoExpired: true });

	await page.getByTestId('remove-passkey').click();
	await page.getByTestId('confirm-remove').click();

	const confirm = page.getByRole('dialog', { name: 'Confirm it’s you' });
	await expect(confirm).toBeVisible();
	await confirm.getByRole('button', { name: 'Use a passkey' }).click();
	await expect(confirm).toHaveCount(0);
	// The retried removal went through on the fresh session.
	await expect(page.getByTestId('no-passkeys')).toBeVisible();
	expect((await stub(context)).passkeys).toHaveLength(0);
});

test('after ten minutes, creating a passkey can be confirmed with the password', async ({
	page,
	context
}) => {
	await instrument(page);
	const authenticator = await addAuthenticator(page);
	await signInWithPassword(page, newUsername());
	await page.goto('/settings/account');
	await stub(context, { sudoExpired: true });

	await page.getByRole('button', { name: 'Create a passkey' }).click();
	const confirm = page.getByRole('dialog', { name: 'Confirm it’s you' });
	// With no passkey yet, only the password can confirm.
	await expect(confirm.getByRole('button', { name: 'Use a passkey' })).toHaveCount(0);
	await expect(confirm.getByLabel('User')).toHaveValue(/^passkey-/);
	await confirm.getByLabel('Password').fill('wrong password');
	await confirm.getByRole('button', { name: 'Confirm' }).click();
	await expect(confirm.getByRole('alert')).toHaveText('That password isn’t right. Try again.');

	await confirm.getByLabel('Password').fill(password);
	await confirm.getByRole('button', { name: 'Confirm' }).click();
	await expect(confirm).toHaveCount(0);
	await expect(page.getByTestId('passkey')).toHaveCount(1);
	expect(await storedCredentials(authenticator)).toHaveLength(1);
});

test('a passkey the account no longer has is explained and signalled', async ({
	page,
	context,
	isMobile
}) => {
	await instrument(page);
	const authenticator = await addAuthenticator(page);
	await signInWithPassword(page, newUsername());
	await createPasskeyInSettings(page, authenticator);
	const [credential] = await storedCredentials(authenticator);
	await stub(context, { forgetPasskeys: true });
	await signOut(page, isMobile);

	await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
	await expect(page.getByTestId('passkey-error')).toHaveText(
		'That passkey isn’t set up for this account anymore. Sign in with your password.'
	);
	await expect(page).toHaveURL(/\/login$/);
	expect(await signals(page)).toContainEqual({
		unknown: {
			rpId: 'localhost',
			credentialId: Buffer.from(credential.credentialId, 'base64').toString('base64url')
		}
	});
});

test('after a password sign-in, a prompt offers a passkey; Not now is remembered', async ({
	page,
	isMobile
}) => {
	await instrument(page);
	await addAuthenticator(page);
	const username = newUsername();
	await signInWithPassword(page, username);

	const nudge = page.getByRole('region', { name: 'Sign in faster with a passkey' });
	await expect(nudge).toContainText('Use your fingerprint, face, or screen lock');
	await nudge.getByRole('button', { name: 'Not now' }).click();
	await expect(nudge).toHaveCount(0);

	await signOut(page, isMobile);
	await signInWithPassword(page, username);
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await expect(page.getByTestId('passkey-nudge')).toHaveCount(0);
});

test('the post-sign-in prompt creates a passkey, and is not shown once there is one', async ({
	page,
	isMobile
}) => {
	await instrument(page);
	const authenticator = await addAuthenticator(page);
	const username = newUsername();
	await signInWithPassword(page, username);

	const nudge = page.getByTestId('passkey-nudge');
	await nudge.getByRole('button', { name: 'Create a passkey' }).click();
	await expect(nudge).toHaveCount(0);
	await expect(
		page.getByRole('status').filter({ hasText: 'Passkey created. Next time, sign in with it.' })
	).toBeVisible();
	expect(await storedCredentials(authenticator)).toHaveLength(1);

	// The prompt only follows a password sign-in, and only for someone without passkeys.
	await page.reload();
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await expect(nudge).toHaveCount(0);
	await signOut(page, isMobile);
	await page.evaluate(() => localStorage.clear());
	await signInWithPassword(page, username);
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await expect(nudge).toHaveCount(0);
});

test('changing the password signs other devices out and keeps this one signed in', async ({
	page,
	browser
}) => {
	await instrument(page);
	const username = newUsername();
	await signInWithPassword(page, username);

	const other = await browser.newContext({ baseURL: origin });
	const otherPage = await other.newPage();
	await signInWithPassword(otherPage, username);

	await page.goto('/settings/account');
	const form = page.getByTestId('password');
	await expect(form).toContainText('Use at least 12 characters');
	await form.getByLabel('Current password').fill(password);
	await form.getByLabel('New password', { exact: true }).fill('short');
	await form.getByLabel('Confirm new password').fill('short');
	await form.getByRole('button', { name: 'Change password' }).click();
	await expect(form).toContainText('Use at least 12 characters.');

	await form.getByLabel('Current password').fill('not my password');
	await form.getByLabel('New password', { exact: true }).fill('a much longer passphrase');
	await form.getByLabel('Confirm new password').fill('a much longer passphrase');
	await form.getByRole('button', { name: 'Change password' }).click();
	await expect(form).toContainText('Your current password isn’t right. Try again.');
	await expect(form.getByLabel('Current password')).toHaveAttribute('aria-invalid', 'true');

	await form.getByLabel('Current password').fill(password);
	await form.getByLabel('New password', { exact: true }).fill('a much longer passphrase');
	await form.getByLabel('Confirm new password').fill('a much longer passphrase');
	await form.getByRole('button', { name: 'Change password' }).click();
	await expect(page.getByTestId('password-changed')).toHaveText(
		'Password changed. Other devices were signed out.'
	);
	await expect(form.getByLabel('Current password')).toHaveValue('');

	// This browser holds the fresh session; the other one was signed out.
	await page.reload();
	await expect(page).toHaveURL(/\/settings\/account$/);
	await otherPage.reload();
	await expect(otherPage).toHaveURL(/\/login$/);
	await signInWithPassword(otherPage, username, 'a much longer passphrase');
	await other.close();
});

test('signed out, the account JSON endpoints answer 401 instead of redirecting', async ({
	request
}) => {
	for (const [method, path] of [
		['GET', '/settings/account/passkeys'],
		['POST', '/settings/account/passkeys/options'],
		['DELETE', '/settings/account/passkeys/3f2a1c9e-7b4d-4e8a-9c1f-2d3e4f5a6b7c'],
		['POST', '/settings/account/reauthenticate']
	] as const) {
		const response = await request.fetch(`${origin}${path}`, {
			method,
			headers: { 'content-type': 'application/json' },
			data: method === 'GET' || method === 'DELETE' ? undefined : {},
			maxRedirects: 0
		});
		expect(response.status(), `${method} ${path}`).toBe(401);
		expect(response.headers()['cache-control']).toBe('no-store');
	}
	// The passkey sign-in endpoints are public.
	const options = await request.post(`${origin}/login/passkey/options`, {
		data: {},
		maxRedirects: 0
	});
	expect(options.status()).toBe(200);
	expect(Object.keys(await options.json())).toEqual(['publicKey']);
});

test('a passkey offered in the User field’s autofill signs in', async ({ page, isMobile }) => {
	await instrument(page, { autofill: true });
	const authenticator = await addAuthenticator(page);
	await signInWithPassword(page, newUsername());
	await createPasskeyInSettings(page, authenticator);
	if (isMobile) await page.getByLabel('Your account').click();
	await page.getByRole('button', { name: 'Sign out' }).click();

	// The virtual authenticator answers the conditional request as if the passkey was picked.
	await expect(page).toHaveURL(`${origin}/`);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('hi, passkey');
});

test('when a silent passkey upgrade doesn’t answer, the prompt is offered anyway', async ({
	page
}) => {
	// Chromium's virtual authenticator leaves a conditional create pending, as a browser may when
	// its password manager declines silently.
	await instrument(page, { upgrade: true });
	const authenticator = await addAuthenticator(page);
	await signInWithPassword(page, newUsername());

	const nudge = page.getByTestId('passkey-nudge');
	await expect(nudge).toBeVisible();
	// Creating one from the prompt replaces the pending silent request.
	await nudge.getByRole('button', { name: 'Create a passkey' }).click();
	await expect(nudge).toHaveCount(0);
	expect(await storedCredentials(authenticator)).toHaveLength(1);
});

test('with passkeys switched off, Account settings and the sign-in nudge leave them out', async ({
	page,
	context,
	isMobile
}) => {
	await instrument(page);
	await addAuthenticator(page);
	const username = newUsername();
	await signInWithPassword(page, username);
	await stub(context, { passkeysDisabled: true });

	await page.goto('/settings/account');
	await expect(page.getByTestId('profile')).toContainText(`@${username}`);
	await expect(page.getByTestId('password')).toBeVisible();
	await expect(page.getByRole('region', { name: 'Passkeys' })).toHaveCount(0);
	await expect(page.getByRole('alert')).toHaveCount(0);

	// A fresh password sign-in reads passkeysEnabled: false and never suggests one.
	await signOut(page, isMobile);
	await signInWithPassword(page, username);
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await expect(page.getByTestId('passkey-nudge')).toHaveCount(0);
});

for (const autofill of [true, false])
	test(`with passkeys switched off, the sign-in page drops its passkey button (autofill ${autofill ? 'on' : 'off'})`, async ({
		page
	}) => {
		await instrument(page, { autofill });
		await addAuthenticator(page);
		await page.route('**/login/passkey/options', (route) =>
			route.fulfill({
				status: 503,
				contentType: 'application/json',
				body: JSON.stringify({
					code: 'passkeys_disabled',
					message: 'Passkeys aren’t available here. Sign in with your password.'
				})
			})
		);
		await page.goto('/login');
		const button = page.getByRole('button', { name: 'Sign in with a passkey' });
		// Autofill's own options call finds passkeys off; otherwise the button's first use does.
		if (!autofill) await button.click();
		await expect(button).toHaveCount(0);
		await expect(page.getByRole('alert')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
	});
