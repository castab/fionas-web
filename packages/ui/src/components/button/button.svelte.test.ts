import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import Button from './button.svelte';

const label = (text: string) => createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

describe('Button', () => {
	it('renders a type="button" button by default', async () => {
		render(Button, { children: label('Save') });
		await expect
			.element(page.getByRole('button', { name: 'Save' }))
			.toHaveAttribute('type', 'button');
	});

	it('renders a link when given an href', async () => {
		render(Button, { href: '/menu', children: label('Menu') });
		await expect.element(page.getByRole('link', { name: 'Menu' })).toHaveAttribute('href', '/menu');
	});

	it('drops the href of a disabled link', async () => {
		render(Button, { href: '/menu', disabled: true, children: label('Menu') });
		const link = page.getByRole('link', { name: 'Menu' });
		await expect.element(link).not.toHaveAttribute('href');
		await expect.element(link).toHaveAttribute('aria-disabled', 'true');
	});
});
