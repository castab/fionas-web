import type { Page } from '@playwright/test';

/** Helpers for filling in /book, shared by the booking specs. */

export const stub = `http://127.0.0.1:${process.env.COMMERCE_STUB_PORT ?? '4174'}`;

export type Submission = import('@fionas/shared').CreateInquiryRequest;

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
	await page.getByLabel('Email', { exact: true }).fill(email);
	await page.getByLabel('Event ZIP code').fill('02134');
	await page.getByLabel('Event date').fill('2026-12-05');
	await page.getByLabel('Event type').selectOption('BIRTHDAY');
}

/** The guest count: enough for an "estimate so far". There is no service duration. */
export async function fillBasics(page: Page, guests = '75') {
	await page.getByLabel('About how many guests?').fill(guests);
}

export async function fillHandScooped(page: Page) {
	const group = page.getByRole('group', { name: /Hand-scooped — pick 4/ });
	for (const name of ['Chocolate Chip', 'Chocolate', 'Butter Pecan', 'Strawberry']) {
		await group.getByRole('checkbox', { name, exact: true }).check();
	}
}

export async function fillToppings(page: Page) {
	for (const topping of ['Rainbow Sprinkles', 'Chocolate Sauce', 'Caramel Sauce', 'Crushed Oreo']) {
		await page.getByRole('checkbox', { name: topping, exact: true }).check();
	}
}

/** Cones and cups are free and may be combined; at least one is required. */
export async function fillCones(page: Page, names = ['Sugar Cones', 'Cups']) {
	const group = page.getByRole('group', { name: /Cones & cups — pick 1 or more/ });
	for (const name of names) await group.getByRole('checkbox', { name, exact: true }).check();
}

export async function fillService(page: Page, guests = '75') {
	await fillBasics(page, guests);
	await fillHandScooped(page);
	await fillToppings(page);
	await fillCones(page);
}

export const sendButton = (page: Page) =>
	page.getByRole('button', { name: 'Send booking request' });
