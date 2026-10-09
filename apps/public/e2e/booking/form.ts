import type { Page } from '@playwright/test';
import { publishedFor, type PublishedInquiry } from '../nats.js';

/** Helpers for filling in /book, shared by the booking specs. */

export type Submission = import('@fionas/shared').PricedInquiry;

/** Every InquirySubmitted event /book published for this email, with its `Nats-Msg-Id`. */
export const deliveriesFor = (email: string): Promise<PublishedInquiry[]> => publishedFor(email);

/** The inquiry /book published for this email (the event's `data`), if any. */
export async function submissionFor(email: string): Promise<Submission | undefined> {
	return (await publishedFor(email))[0]?.event.data;
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
