import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ChoiceChip from './choice-chip.svelte';

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

	it('marks an unavailable choice, keeping the reason in its accessible name', async () => {
		render(ChoiceChip, {
			name: 'flavor',
			value: 'ube',
			label: 'Ube',
			meta: 'Unavailable — check back later',
			unavailable: true,
			disabled: true
		});
		const box = page.getByRole('checkbox', { name: 'Ube · Unavailable — check back later' });
		await expect.element(box).toBeDisabled();
		const chip = box.element().closest('label') as HTMLElement;
		expect(chip.dataset.unavailable).toBe('');
	});
});
