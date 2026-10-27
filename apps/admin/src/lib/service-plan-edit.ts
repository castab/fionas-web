import type { CurrentStaffRequest } from './request-contract.js';
import type { QuoteCommand, ServicePlanAction, ServicePlanResponse } from './quote-contract.js';
import { proposedServicePlan, type QuoteFormValues } from './quote-builder.js';
import { serviceCommitment } from './service-plan.js';
import { isPlaceholder } from './service-selections.js';

/**
 * What an edited draft means for the current service commitment. The browser never picks RETAIN,
 * REPLACE or CLEAR by field presence: staff either leave the plan alone (RETAIN), change its content
 * (REPLACE) or tick the deliberate "remove" choice (CLEAR), and the server derives the action from
 * the draft against the authoritative current plan.
 */
export type PlanIntent =
	| { ok: true; action: ServicePlanAction; servicePlan?: QuoteCommand['servicePlan'] }
	| { ok: false; error: string };

type DraftPlan = NonNullable<QuoteCommand['servicePlan']>;

function samePlan(draft: DraftPlan, plan: ServicePlanResponse): boolean {
	const items = draft.items ?? [];
	const notes = new Map((draft.lineNotes ?? []).map((n) => [n.lineItemId ?? n.key, n.note]));
	return (
		draft.description === (plan.description ?? '').trim() &&
		(draft.guestCount ?? null) === (plan.guestCount ?? null) &&
		items.length === plan.items.length &&
		items.every(
			(item, i) =>
				item.label === plan.items[i].label &&
				(item.group ?? null) === (plan.items[i].group ?? null) &&
				(item.key ?? null) === (plan.items[i].key ?? null)
		) &&
		notes.size === plan.lineNotes.length &&
		plan.lineNotes.every((n) => notes.get(n.lineItemId) === n.note)
	);
}

export function planIntent(
	values: QuoteFormValues,
	data: Pick<CurrentStaffRequest, 'effectiveServicePlan'>
): PlanIntent {
	const commitment = serviceCommitment(data);
	if (values.clearPlan) {
		return commitment.state === 'APPROVED'
			? { ok: true, action: 'CLEAR' }
			: { ok: false, error: 'There is no approved service plan to remove.' };
	}
	const description = values.description.trim();
	const hasContent =
		!!values.guestCount.trim() ||
		values.items.some((item) => !isPlaceholder(item)) ||
		values.lines.some((l) => l.note.trim());
	if (!description) {
		const removal =
			commitment.state === 'APPROVED'
				? ' To remove the plan on purpose, choose “Remove the service plan”.'
				: '';
		if (hasContent)
			return {
				ok: false,
				error: `Add a service description to keep the guests, selections and line notes with this booking.${removal}`
			};
		// A blank description never means "remove": a deliberate choice is required for that.
		return commitment.state === 'APPROVED'
			? { ok: false, error: `The service plan needs a description.${removal}` }
			: { ok: true, action: 'RETAIN' };
	}
	const proposed = proposedServicePlan(values)!;
	if (commitment.state === 'APPROVED' && samePlan(proposed, commitment.plan))
		return { ok: true, action: 'RETAIN' };
	// A plan's unedited duration is carried unchanged rather than silently dropped by a replacement.
	const duration = commitment.state === 'APPROVED' ? commitment.plan.durationMinutes : undefined;
	return {
		ok: true,
		action: 'REPLACE',
		servicePlan: duration ? { ...proposed, durationMinutes: duration } : proposed
	};
}

/**
 * Notes on lines this draft removes. A removed noted line forces a replacement plan without that
 * note; this lists what would be dropped so it is never lost silently.
 */
export function droppedNotes(
	values: Pick<QuoteFormValues, 'lines'>,
	data: Pick<CurrentStaffRequest, 'effectiveServicePlan' | 'financial'>
): { lineItemId: string; description: string; note: string }[] {
	const commitment = serviceCommitment(data);
	if (commitment.state !== 'APPROVED') return [];
	const kept = new Set(values.lines.map((l) => l.lineItemId).filter(Boolean));
	return commitment.plan.lineNotes.flatMap((n) => {
		const line = data.financial.lines.find((l) => l.id === n.lineItemId);
		return line && !kept.has(n.lineItemId)
			? [{ lineItemId: n.lineItemId, description: line.description, note: n.note }]
			: [];
	});
}
