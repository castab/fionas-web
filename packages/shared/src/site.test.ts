import { describe, expect, it } from 'vitest';
import { instagramUrl, mailtoUrl, site } from './site.ts';
import { comingSoonToast } from './booking.ts';

describe('site details', () => {
	it('derives the Instagram profile URL from the handle', () => {
		expect(instagramUrl).toBe('https://www.instagram.com/fionasicecream/');
	});

	it('builds a mailto link for the contact email', () => {
		expect(mailtoUrl).toBe(`mailto:${site.email}`);
	});
});

describe('coming-soon toast copy', () => {
	it('auto-dismisses after a readable delay', () => {
		expect(comingSoonToast.timeoutMs).toBeGreaterThanOrEqual(5000);
	});
});
