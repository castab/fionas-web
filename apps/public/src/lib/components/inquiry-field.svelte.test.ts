import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { InquiryFormField, OfferingOption } from '@fionas/shared';
import Harness from './inquiry-field-harness.test.svelte';

/*
 * The offering question is rendered purely from the definition the backend sends: these
 * definitions are made up (keys, names and prices of no real catalog revision) so nothing here can
 * pass by accident of a hardcoded menu.
 */

const option = (
	key: string,
	displayName: string,
	extra: Partial<OfferingOption> = {}
): OfferingOption => ({
	key,
	category: 'test-scoop',
	displayName,
	selectionState: 'ENABLED',
	availability: 'AVAILABLE',
	...extra
});

function scoops(
	options: OfferingOption[],
	limits: { min?: number; max?: number } = {}
): InquiryFormField {
	return {
		key: 'offering:test-scoop',
		label: 'Pick test scoops',
		description: 'Described by the backend.',
		submissionPointer: '/serviceInputs/selections',
		required: (limits.min ?? 1) > 0,
		input: {
			type: 'OFFERING_CHOICE',
			category: 'test-scoop',
			minSelections: limits.min ?? 1,
			maxSelections: limits.max,
			options
		},
		presentation: { control: 'CHECKBOXES' }
	};
}

// Deliberately not alphabetical, so backend order is distinguishable from any sorting.
const menu = [
	option('zeta-swirl', 'Zeta Swirl', {
		price: { kind: 'PER_QUANTITY', amount: '0.40', currency: 'USD', dimension: 'guest' }
	}),
	option('alpha-ripple', 'Alpha Ripple', { availability: 'UNAVAILABLE' }),
	option('mid-melt', 'Mid Melt', { description: 'A backend-supplied description' }),
	option('beta-burst', 'Beta Burst', {
		price: { kind: 'FIXED', amount: '12.00', currency: 'USD' }
	})
];

const answer = () => page.getByTestId('answer');
const box = (name: RegExp | string) => page.getByRole('checkbox', { name });

describe('offering question rendering', () => {
	it('enforces a backend-defined exactly-four group', async () => {
		render(Harness, {
			field: scoops(
				Array.from({ length: 5 }, (_, i) => option(`scoop-${i}`, `Scoop ${i}`)),
				{ min: 4, max: 4 }
			)
		});
		await expect.element(page.getByText('0 of 4 picked')).toBeVisible();
		for (let i = 0; i < 4; i++) await box(`Scoop ${i}`).click();
		await expect.element(page.getByText('4 of 4 picked')).toBeVisible();
		await expect.element(box('Scoop 4')).toBeDisabled();
		await box('Scoop 0').click();
		await expect.element(box('Scoop 4')).toBeEnabled();
	});

	it('retains price, notes and details on an unavailable option', async () => {
		render(Harness, {
			field: scoops([
				option('returning', 'Returning Scoop', {
					availability: 'UNAVAILABLE',
					badge: 'Returning soon',
					statusNote: 'Back this fall',
					infoNote: 'Contains nuts',
					price: { kind: 'FIXED', amount: '12.00', currency: 'USD' }
				})
			])
		});
		await expect.element(box(/Returning Scoop/)).toBeDisabled();
		await expect.element(box(/Returning Scoop/)).toHaveAccessibleDescription('Back this fall');
		await expect.element(page.getByText('· +$12')).toBeVisible();
		await expect.element(page.getByText('Returning soon')).toBeVisible();
		await page.getByRole('button', { name: 'More about Returning Scoop' }).click();
		await expect.element(page.getByText('Contains nuts')).toBeVisible();
		await expect.element(answer()).toHaveTextContent('null');
	});
	it('labels the group and its choices from the definition, in backend order', async () => {
		render(Harness, { field: scoops(menu, { min: 1, max: 2 }) });

		const group = page.getByRole('group', { name: /Pick test scoops/ });
		await expect.element(group).toBeVisible();
		await expect.element(group).toHaveAccessibleDescription(/Described by the backend\./);
		const names = page
			.getByRole('checkbox')
			.elements()
			.map((el) => (el as HTMLInputElement).value);
		expect(names).toEqual(['zeta-swirl', 'alpha-ripple', 'mid-melt', 'beta-burst']);
		await expect.element(page.getByText('+$0.40/guest')).toBeVisible();
		await expect.element(page.getByText('+$12')).toBeVisible();
		await expect
			.element(box(/Mid Melt/))
			.toHaveAttribute('title', 'A backend-supplied description');
	});

	it('shows the min/max limits and stops further picks at the maximum', async () => {
		render(Harness, { field: scoops(menu, { min: 1, max: 2 }) });

		await expect.element(page.getByText('0 picked · choose 1–2')).toBeVisible();
		await box(/Zeta Swirl/).click();
		await box(/Mid Melt/).click();
		await expect.element(page.getByText('2 picked · choose 1–2')).toBeVisible();
		await expect.element(box(/Beta Burst/)).toBeDisabled();
		await expect.element(box(/Zeta Swirl/)).toBeEnabled();
		await expect.element(answer()).toHaveTextContent('["zeta-swirl","mid-melt"]');
	});

	it('lets an AVAILABLE option be selected', async () => {
		render(Harness, { field: scoops(menu) });

		await box(/Zeta Swirl/).click();
		await expect.element(box(/Zeta Swirl/)).toBeChecked();
		await expect.element(answer()).toHaveTextContent('["zeta-swirl"]');
	});

	it('keeps an UNAVAILABLE option visible and readable but never selectable', async () => {
		render(Harness, { field: scoops(menu) });

		const unavailable = box(/Alpha Ripple/);
		await expect.element(unavailable).toBeVisible();
		await expect.element(unavailable).toBeDisabled();
		// No in-chip notice: the disabled state (and any status note) carries it.
		await expect.element(unavailable).toHaveAccessibleName('Alpha Ripple');
		await expect.element(page.getByText(/check back later/)).not.toBeInTheDocument();
		const chip = unavailable.element().closest('[data-slot="choice-chip"]') as HTMLElement;
		expect(chip.hasAttribute('data-unavailable')).toBe(true);

		// A click (even one that skips the disabled check) can't select it.
		(unavailable.element() as HTMLInputElement).click();
		await expect.element(unavailable).not.toBeChecked();
		await expect.element(answer()).toHaveTextContent('null');
	});

	it('lets a stale unavailable pick be unchecked, but not checked again', async () => {
		render(Harness, {
			field: scoops(menu),
			initial: { 'offering:test-scoop': ['alpha-ripple'] }
		});

		const stale = box(/Alpha Ripple/);
		await expect.element(stale).toBeChecked();
		await stale.click();
		await expect.element(stale).not.toBeChecked();
		await expect.element(stale).toBeDisabled();
		await expect.element(answer()).toHaveTextContent('[]');
	});

	it('explains when too few options are available to meet the minimum', async () => {
		render(Harness, {
			field: scoops(
				[
					option('only-one', 'Only One'),
					option('gone-now', 'Gone Now', { availability: 'UNAVAILABLE' })
				],
				{ min: 2, max: 2 }
			)
		});

		await expect
			.element(
				page.getByText(/Only 1 is available right now, so this can't be completed online today/)
			)
			.toBeVisible();
	});

	it('ties an error to the group for assistive technology', async () => {
		render(Harness, { field: scoops(menu), error: 'Choose at least 1.' });

		await expect
			.element(page.getByRole('group', { name: /Pick test scoops/ }))
			.toHaveAccessibleDescription(/Choose at least 1\./);
	});
});

describe('explicit CHIPS presentation', () => {
	it.each(['INTEGER_CHOICE', 'STRING_CHOICE'] as const)(
		'renders a long %s list as radios and submits only its value',
		async (type) => {
			const options = Array.from({ length: 7 }, (_, i) => ({
				value: type === 'INTEGER_CHOICE' ? i + 1 : `choice-${i}`,
				label: `Choice ${i}`,
				badge: i === 0 ? 'Featured' : undefined,
				statusNote: i === 0 ? 'For this season' : undefined,
				infoNote: i === 0 ? 'More facts' : undefined
			}));
			const field: InquiryFormField = {
				key: 'test-choice',
				label: 'Pick a choice',
				submissionPointer: '/test',
				required: true,
				input: { type, options } as InquiryFormField['input'],
				presentation: { control: 'CHIPS' }
			};
			render(Harness, { field });
			expect(
				page
					.getByRole('radio')
					.elements()
					.map((el) => (el as HTMLInputElement).value)
			).toEqual(options.map((o) => String(o.value)));
			await expect.element(page.getByRole('combobox')).not.toBeInTheDocument();
			const first = page.getByRole('radio', { name: /Choice 0/ });
			await expect.element(first).toHaveAccessibleDescription('For this season');
			await page.getByRole('button', { name: 'More about Choice 0' }).click();
			await expect.element(page.getByText('More facts')).toBeVisible();
			await expect.element(first).not.toBeChecked();
			await first.click();
			await expect.element(answer()).toHaveTextContent(JSON.stringify(String(options[0]!.value)));
			const form = (first.element() as HTMLInputElement).form!;
			expect([...new FormData(form).entries()]).toEqual([
				['test-choice', String(options[0]!.value)]
			]);
		}
	);

	it.each(['STRING_CHOICE', 'INTEGER_CHOICE'] as const)(
		'preserves SELECT for a long %s list',
		async (type) => {
			const field: InquiryFormField = {
				key: 'test-choice',
				label: 'Pick a choice',
				submissionPointer: '/test',
				required: true,
				input: {
					type,
					options: Array.from({ length: 7 }, (_, i) => ({
						value: type === 'INTEGER_CHOICE' ? i : String(i),
						label: `Choice ${i}`
					}))
				} as InquiryFormField['input'],
				presentation: { control: 'SELECT' }
			};
			render(Harness, { field });
			await expect.element(page.getByRole('combobox', { name: /Pick a choice/ })).toBeVisible();
		}
	);
});
