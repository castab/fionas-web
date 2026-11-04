<script lang="ts">
	import CategorizedSelections from './categorized-selections.svelte';
	import { receivedTimeLabel } from '$lib/payments.js';
	import type { ApprovalEntry } from '$lib/revision-history.js';
	let { approvals, userId }: { approvals: ApprovalEntry[]; userId: string } = $props();
	const micro =
		'm-0 font-sans text-[9.5px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-muted) uppercase';
	const who = (id: string) => (id === userId ? 'You' : 'Staff');
	const pill = `rounded-full border border-olive-300 px-2 py-0.5 whitespace-nowrap ${micro}`;
</script>

<!-- Service approvals advance on their own revision counter, and a service-only change never
     appears in Activity, so this list is the one place they are all shown. Newest first. -->
<ol class="m-0 flex list-none flex-col gap-2 p-0" data-testid="history-approvals">
	{#each approvals as entry (entry.plan.revision)}
		<li class="flex flex-col gap-1 rounded-input bg-cream-200 px-3 py-2.5 text-[13px]">
			<div class="flex flex-wrap items-center gap-2">
				<span class="font-semibold">{entry.label}</span>
				<span class="text-(--text-muted)">Revision {entry.plan.revision}</span>
				{#if entry.current}<span class={pill}>Current</span>{/if}
				{#if entry.accepted}<span class={pill}>Accepted with the deposit</span>{/if}
			</div>
			<p class="m-0 text-[11.5px] text-(--text-muted)">
				<time datetime={entry.plan.approvedAt}>{receivedTimeLabel(entry.plan.approvedAt)}</time>
				· {who(entry.plan.approvedBy)}
				· Reviewed v{entry.plan.reviewedDocumentVersion}, recorded on {entry.source} v{entry.plan
					.documentVersion}
			</p>
			{#if !entry.plan.cleared}
				<details class="text-[12.5px]">
					<summary class="min-h-11 cursor-pointer py-2 font-semibold">View this plan</summary>
					<div class="flex flex-col gap-2 pb-1">
						<p class="m-0 leading-[1.6] wrap-anywhere whitespace-pre-wrap">
							{entry.plan.description}{entry.plan.guestCount
								? ` · ${entry.plan.guestCount} guest${entry.plan.guestCount === 1 ? '' : 's'}`
								: ''}
						</p>
						<CategorizedSelections items={entry.plan.items} headingLevel={4} inset />
						{#if entry.plan.lineNotes.length}<p class="m-0 text-[11.5px] text-(--text-muted)">
								{entry.plan.lineNotes.length} line note{entry.plan.lineNotes.length === 1
									? ''
									: 's'}
							</p>{/if}
					</div>
				</details>
			{/if}
		</li>
	{/each}
</ol>
