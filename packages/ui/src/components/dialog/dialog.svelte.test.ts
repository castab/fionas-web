import { describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import Host from './dialog-test-host.svelte';

describe('Dialog', () => {
	it('opens as a labelled, described modal dialog', async () => {
		render(Host);
		await page.getByRole('button', { name: 'Open' }).click();
		const dialog = page.getByRole('dialog', { name: 'Remove this passkey?' });
		await expect.element(dialog).toBeVisible();
		await expect.element(dialog).toHaveAccessibleDescription('You can add it again later.');
		await expect.element(page.getByRole('button', { name: 'Close' })).toBeVisible();
	});

	it('closes with Escape and with its close buttons', async () => {
		render(Host, { open: true });
		const dialog = page.getByRole('dialog');
		await expect.element(dialog).toBeVisible();
		await userEvent.keyboard('{Escape}');
		await expect.element(dialog).not.toBeInTheDocument();

		await page.getByRole('button', { name: 'Open' }).click();
		await page.getByRole('button', { name: 'Cancel' }).click();
		await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	});
});
