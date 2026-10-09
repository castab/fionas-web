import type { FieldErrors, InquiryForm, InquiryFormField } from '@fionas/shared';

/** A live note under a choice group; `done` once the customer has completed it. */
export type FieldNote = { text: string; done: boolean };

/**
 * The trailer's third soft-serve handle swirls the two flavors picked, so a pick-two soft-serve
 * question explains that, then names the swirl once both are chosen.
 */
export function swirlNote(
	field: InquiryFormField,
	picked: readonly string[]
): FieldNote | undefined {
	const input = field.input;
	if (
		input.type !== 'OFFERING_CHOICE' ||
		input.category !== 'soft-serve-flavor' ||
		input.maxSelections !== 2
	)
		return undefined;
	const names = picked
		.map((key) => input.options.find((o) => o.key === key)?.displayName)
		.filter((name): name is string => !!name);
	return names.length === 2
		? { text: `Your swirl: ${names.join(' + ')} — the third handle comes free.`, done: true }
		: { text: 'The third flavor is always a swirl of your two picks.', done: false };
}

/** "Please add: your name, event date." for the fields with errors, in form order. */
export function missingSummary(form: InquiryForm, errors: FieldErrors): string | null {
	const missing = form.sections
		.flatMap((section) => section.fields)
		.filter((field) => errors[field.key])
		.map((field) => field.presentation.summaryLabel ?? field.label.toLowerCase());
	return missing.length ? `Please add: ${missing.join(', ')}.` : null;
}
