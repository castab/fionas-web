import { describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ChoiceChip from './choice-chip.svelte';

/** The open popover's text (bits-ui portals it to the body), or undefined when closed. */ const popover =
	() => document.querySelector('[data-slot="popover-content"]')?.textContent?.trim();
describe('ChoiceChip', () => {
	it('renders a named checkbox labelled with its text and meta', async () => {
		render(ChoiceChip, {
			name: 'flavor',
			value: 'horchata',
			label: 'Horchata',
			meta: '+$0.50/guest'
		});
		const box = page.getByRole('checkbox', { name: /Horchata/ });
		await expect.element(box).toHaveAttribute('name', 'flavor');
		await expect.element(box).toHaveAttribute('value', 'horchata');
		await expect.element(page.getByText('+$0.50/guest')).toBeVisible();
	});

	it('can be a radio and selects when clicked', async () => {
		render(ChoiceChip, { type: 'radio', name: 'cone', value: 'cup', label: 'Cups' });
		const radio = page.getByRole('radio', { name: 'Cups' });
		await expect.element(radio).not.toBeChecked();
		await radio.click();
		await expect.element(radio).toBeChecked();
	});

	it('can be disabled', async () => {
		render(ChoiceChip, { name: 'flavor', value: 'vanilla', label: 'Vanilla', disabled: true });
		await expect.element(page.getByRole('checkbox', { name: 'Vanilla' })).toBeDisabled();
	});

	it('marks an unavailable choice', async () => {
		render(ChoiceChip, {
			name: 'flavor',
			value: 'ube',
			label: 'Ube',
			unavailable: true,
			disabled: true
		});
		const box = page.getByRole('checkbox', { name: 'Ube' });
		await expect.element(box).toBeDisabled();
		const chip = box.element().closest('[data-slot="choice-chip"]') as HTMLElement;
		expect(chip.dataset.unavailable).toBe('');
	});

	it('opens the badge status and info popovers without selecting the choice', async () => {
		render(ChoiceChip, {
			name: 'flavor',
			value: 'test-scoop',
			label: 'Test Scoop',
			meta: '+$0.50/guest',
			badge: 'Featured',
			statusNote: 'Available this season',
			infoNote: 'Contains milk'
		});
		const box = page.getByRole('checkbox', { name: /Test Scoop/ });
		await expect.element(page.getByText('+$0.50/guest')).toBeVisible();
		await expect.element(box).toHaveAccessibleDescription('Available this season');
		await expect.element(page.getByText('Contains milk')).not.toBeInTheDocument();

		await page.getByRole('button', { name: 'Featured' }).click();
		await expect.poll(popover).toBe('Available this season');
		await expect.element(box).not.toBeChecked();

		await page.getByRole('button', { name: 'More about Test Scoop' }).click();
		await expect.element(page.getByText('Contains milk')).toBeVisible();
		await expect.element(box).not.toBeChecked();
	});

	it('shows a plain badge and drops a status note that has no badge', async () => {
		render(ChoiceChip, { label: 'Plain', badge: 'New' });
		await expect.element(page.getByText('New')).toBeVisible();
		await expect.element(page.getByRole('button')).not.toBeInTheDocument();
		document.body.innerHTML = '';
		render(ChoiceChip, { label: 'Quiet', statusNote: 'Hidden note' });
		const box = page.getByRole('checkbox', { name: 'Quiet' });
		await expect.element(box).not.toHaveAccessibleDescription('Hidden note');
		await expect.element(page.getByText('Hidden note')).not.toBeInTheDocument();
	});

	it('opens the status and details of an unavailable chip without selecting it', async () => {
		render(ChoiceChip, {
			label: 'Test Scoop',
			disabled: true,
			unavailable: true,
			badge: 'Coming soon',
			statusNote: 'Back this fall',
			infoNote: 'Contains tree nuts'
		});
		const box = page.getByRole('checkbox', { name: /Test Scoop/ });
		await expect.element(box).toHaveAccessibleDescription('Back this fall');
		// The pill-wide hit area needs the app's CSS; e2e covers tapping the pill itself.
		await page.getByRole('button', { name: 'Coming soon' }).click();
		await expect.poll(popover).toBe('Back this fall');
		await userEvent.keyboard('{Escape}');
		await expect.poll(popover).toBeUndefined();

		await page.getByRole('button', { name: 'More about Test Scoop' }).click();
		await expect.element(page.getByText('Contains tree nuts')).toBeVisible();
		await expect.element(box).toBeDisabled();
		await expect.element(box).not.toBeChecked();
	});
});
