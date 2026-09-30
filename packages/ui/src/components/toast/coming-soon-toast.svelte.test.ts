import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import Harness from './coming-soon-harness.test.svelte';
import { dismissComingSoonToast } from './coming-soon-toast-state.svelte.js';

const toast = {
	title: 'Booking opens soon',
	description: 'Still setting up the calendar.',
	actionLabel: 'Follow on Instagram',
	actionHref: 'https://www.instagram.com/fionasicecream/',
	timeoutMs: 9000
};

afterEach(() => dismissComingSoonToast());

describe('ComingSoonButton + ComingSoonToast', () => {
	it('marks the CTA aria-disabled without disabling it', async () => {
		render(Harness, { toast });
		const button = page.getByRole('button', { name: 'Book' });
		await expect.element(button).toHaveAttribute('aria-disabled', 'true');
		// Still a real, focusable button (not `disabled`) so the click can raise the toast.
		await expect.element(button).not.toHaveAttribute('disabled');
	});

	it('raises the toast on click, links out to Instagram, and dismisses', async () => {
		render(Harness, { toast });
		await expect.element(page.getByText('Booking opens soon')).not.toBeInTheDocument();

		await page.getByRole('button', { name: 'Book' }).click({ force: true });
		await expect.element(page.getByText('Booking opens soon')).toBeVisible();
		const action = page.getByRole('link', { name: 'Follow on Instagram' });
		await expect.element(action).toHaveAttribute('href', toast.actionHref);
		await expect.element(action).toHaveAttribute('target', '_blank');

		await page.getByRole('button', { name: 'Dismiss' }).click();
		await expect.element(page.getByText('Booking opens soon')).not.toBeInTheDocument();
	});

	it('auto-dismisses after the timeout', async () => {
		render(Harness, { toast: { ...toast, timeoutMs: 300 } });
		await page.getByRole('button', { name: 'Book' }).click({ force: true });
		await expect.element(page.getByText('Booking opens soon')).toBeVisible();
		await expect.element(page.getByText('Booking opens soon')).not.toBeInTheDocument();
	});
});
