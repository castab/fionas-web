<script lang="ts">
	import type { AnswerValue, InquiryFormField, InquiryPricingPreview } from '@fionas/shared';
	import { untrack } from 'svelte';
	import InquiryField from './inquiry-field.svelte';

	/** Test-only: binds one question's answers the way /book does, and shows them for assertions. */
	let {
		field,
		initial = {},
		error,
		preview
	}: {
		field: InquiryFormField;
		initial?: Record<string, AnswerValue>;
		error?: string;
		preview?: InquiryPricingPreview;
	} = $props();

	// Seeded once from `initial`, then owned here like /book's answers.
	let values = $state<Record<string, AnswerValue>>({ ...untrack(() => initial) });
</script>

<form><InquiryField {field} bind:values {error} {preview} /></form>
<output data-testid="answer">{JSON.stringify(values[field.key] ?? null)}</output>
