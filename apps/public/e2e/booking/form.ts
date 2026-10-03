import type { Page } from '@playwright/test';

/** Helpers for filling in /book, shared by the booking specs. */

export const stub = `http://127.0.0.1:${process.env.COMMERCE_STUB_PORT ?? '4174'}`;

export type Submission = {
	name: string;
	email: string;
	message?: string;
	pricingInputs: {
		catalogRevision: number;
		guestCount: number;
		guestCountIsMinimum: boolean;
		durationMinutes: number;
		selections: { category: string; offerings: string[] }[];
	};
};

/** One POST /inquiries the stub saw: under which key, with which access token, and whether it
 * accepted that token. */
export type Attempt = {
	email: string | null;
	key: string | null;
	token: string | null;
	authorized: boolean;
};

/** Inquiries the stub committed for this email. */
export async function submissionsFor(page: Page, email: string): Promise<Submission[]> {
	const all = (await (await page.request.get(`${stub}/__submissions`)).json()) as Submission[];
	return all.filter((s) => s.email === email);
}

export async function submissionFor(page: Page, email: string): Promise<Submission | undefined> {
	return (await submissionsFor(page, email))[0];
}

/** Every POST /inquiries the app made for this email, in order. */
export async function attemptsFor(page: Page, email: string): Promise<Attempt[]> {
	const all = (await (await page.request.get(`${stub}/__attempts`)).json()) as Attempt[];
	return all.filter((a) => a.email === email);
}

export async function fillContact(page: Page, email: string) {
	await page.getByLabel('Your name').fill('Jane Doe');
	await page.getByLabel('Email address').fill(email);
	await page.getByLabel('ZIP code').fill('02134');
	await page.getByLabel('Event date').fill('2026-12-05');
	await page.getByLabel('Event type').selectOption('BIRTHDAY');
}

/** Guest count and service length: enough for an "estimate so far". */
export async function fillBasics(page: Page, guests = '75') {
	await page.getByLabel('How many guests?').fill(guests);
	await page.getByRole('radio', { name: '2 hours' }).check();
}

export async function fillHandScooped(page: Page) {
	const group = page.getByRole('group', { name: /Choose your hand-scooped flavors/ });
	for (const name of ['Chocolate Chip', 'Chocolate', 'Vanilla Bean', 'Strawberry']) {
		await group
			.getByRole('checkbox', {
				name: new RegExp('^Hand-scooped ' + name + '(?: Crowd favorite| ·|$)')
			})
			.check();
	}
}

export async function fillService(page: Page, guests = '75') {
	await fillBasics(page, guests);
	await page.getByRole('checkbox', { name: 'Vanilla', exact: true }).check();
	await page.getByRole('checkbox', { name: 'Horchata' }).check();
	await fillHandScooped(page);
	for (const topping of ['sprinkles', 'oreos', 'strawberries', 'brownies']) {
		await page.getByRole('checkbox', { name: topping }).check();
	}
	await page.getByRole('radio', { name: 'Waffle cones' }).check();
}

export const sendButton = (page: Page) => page.getByRole('button', { name: 'Send request' });
