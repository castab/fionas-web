import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import Field from './field.svelte';

const control = createRawSnippet<
	[{ id: string; describedby: string | undefined; invalid: boolean }]
>((args) => ({
	render: () => {
		const { id, describedby, invalid } = args();
		return `<input id="${id}" aria-describedby="${describedby ?? ''}" aria-invalid="${invalid}" />`;
	}
}));

describe('Field', () => {
	it('labels the control and wires the description and error to it', async () => {
		render(Field, {
			label: 'Email address',
			description: "We'll follow up here.",
			error: 'Enter an email address.',
			required: true,
			children: control
		});
		const input = page.getByLabelText('Email address');
		await expect.element(input).toHaveAttribute('aria-invalid', 'true');
		await expect
			.element(input)
			.toHaveAccessibleDescription("We'll follow up here. Enter an email address.");
	});

	it('renders a fieldset with a legend in group mode', async () => {
		render(Field, { label: 'Toppings', group: true, children: control });
		await expect.element(page.getByRole('group', { name: 'Toppings' })).toBeVisible();
	});
});
