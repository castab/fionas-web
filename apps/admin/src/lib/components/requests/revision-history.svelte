<script lang="ts">
	import CategorizedSelections from './categorized-selections.svelte';
	import { Button, Card } from '@fionas/ui';
	import { depositTermsLabel } from '$lib/deposit.js';
	import { receivedTimeLabel } from '$lib/payments.js';
	import { formatMoney } from '$lib/presentation.js';
	import { approvalEntries, publicationEntries } from '$lib/revision-history.js';
	import { financialStageLabel } from '$lib/request-workspace.js';
	import type { CurrentStaffRequest } from '$lib/request-contract.js';
	import type {
		DepositRequirementHistoryResponse,
		FinancialDocumentHistoryResponse
	} from '$lib/request-contract.js';

	type History =
		| {
				state: 'ready';
				documents: FinancialDocumentHistoryResponse;
				deposits: DepositRequirementHistoryResponse;
		  }
		| { state: 'unavailable' }
		| null;
	let {
		request,
		history,
		open,
		openHref,
		closeHref,
		userId
	}: {
		request: CurrentStaffRequest;
		/** Financial versions and deposit revisions, read only while `?history` is open. */
		history: History;
		open: boolean;
		openHref: string;
		closeHref: string;
		userId: string;
	} = $props();
	const publications = $derived(publicationEntries(request));
	const approvals = $derived(approvalEntries(request));
	const caps =
		'm-0 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-heading) uppercase';
	const micro =
		'm-0 font-sans text-[9.5px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-muted) uppercase';
	const who = (id: string) => (id === userId ? 'You' : 'Staff');
	const pill = `rounded-full border border-olive-300 px-2 py-0.5 whitespace-nowrap ${micro}`;
</script>

<Card
	id="revision-history"
	role="region"
	aria-labelledby="revision-history-title"
	class="flex flex-col gap-4 p-[18px] sm:p-5"
	data-testid="revision-history"
>
	<div class="flex flex-col gap-1">
		<h2 id="revision-history-title" class={caps}>Revision history</h2>
		<p class="m-0 text-[11.5px] text-(--text-muted)">
			Read only. Quote publications, service plan approvals and financial versions are separate
			histories: one can advance without the others.
		</p>
	</div>

	{#if publications.length}
		<section class="flex flex-col gap-2" aria-labelledby="history-publications">
			<h3 id="history-publications" class={micro}>Quote publications</h3>
			<ol class="m-0 flex list-none flex-col gap-2 p-0" data-testid="history-publications">
				{#each publications as entry (entry.proposal.id)}
					<li class="flex flex-col gap-1 rounded-input bg-cream-200 px-3 py-2.5 text-[13px]">
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-semibold">{entry.kind}</span>
							<span class={pill}>{entry.status}</span>
							<span class="text-(--text-muted)">Quote v{entry.proposal.documentVersion}</span>
						</div>
						<p class="m-0 text-[11.5px] text-(--text-muted)">
							<time datetime={entry.proposal.issuedAt}
								>{receivedTimeLabel(entry.proposal.issuedAt)}</time
							>
							· {who(entry.proposal.issuedBy)}
							· Deposit terms revision {entry.proposal.depositRequirementRevision}{entry.proposal
								.servicePlanRevision
								? ` · Service plan revision ${entry.proposal.servicePlanRevision}`
								: ''}
						</p>
						{#if entry.changes.length}<p class="m-0 text-[11.5px]">
								Changed: {entry.changes.join(', ')}
							</p>{/if}
					</li>
				{/each}
			</ol>
		</section>
	{/if}

	{#if approvals.length}
		<section class="flex flex-col gap-2" aria-labelledby="history-approvals">
			<h3 id="history-approvals" class={micro}>Service plan approvals</h3>
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
							<time datetime={entry.plan.approvedAt}
								>{receivedTimeLabel(entry.plan.approvedAt)}</time
							>
							· {who(entry.plan.approvedBy)}
							· Reviewed v{entry.plan.reviewedDocumentVersion}, recorded on {entry.source} v{entry
								.plan.documentVersion}
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
		</section>
	{/if}

	<section
		class="flex flex-col gap-2 border-t border-(--border-soft) pt-3"
		aria-labelledby="history-versions"
	>
		<div class="flex flex-wrap items-center justify-between gap-2">
			<h3 id="history-versions" class={micro}>Financial versions and deposit terms</h3>
			{#if open}
				<Button href={closeHref} variant="ghost" size="sm" data-testid="history-close">Hide</Button>
			{:else}
				<Button href={openHref} variant="secondary" size="sm" data-testid="history-open"
					>Show versions</Button
				>
			{/if}
		</div>
		{#if open && history?.state === 'ready'}
			<ol class="m-0 flex list-none flex-col gap-2 p-0" data-testid="history-versions">
				{#each [...history.documents.versions].reverse() as version (version.version)}
					<li class="flex flex-col gap-1 rounded-input bg-cream-200 px-3 py-2.5 text-[13px]">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<span class="font-semibold"
								>{financialStageLabel(version.stage)} v{version.version}</span
							>
							<span class="font-semibold">{formatMoney(version.total, version.currency)}</span>
						</div>
						<p class="m-0 text-[11.5px] text-(--text-muted)">
							<time datetime={version.createdAt}>{receivedTimeLabel(version.createdAt)}</time>
							· {version.lines.length} line{version.lines.length === 1 ? '' : 's'}
							{#if version.version === request.financial.version}· Current{/if}
						</p>
						<details class="text-[12.5px]">
							<summary class="min-h-11 cursor-pointer py-2 font-semibold">View lines</summary>
							<ul class="m-0 list-none p-0">
								{#each version.lines as line (line.id)}
									<li class="flex justify-between gap-3 py-1">
										<span class="min-w-0 wrap-anywhere">{line.description}</span><span
											class="whitespace-nowrap">{formatMoney(line.total, line.currency)}</span
										>
									</li>
								{/each}
							</ul>
						</details>
					</li>
				{/each}
			</ol>
			{#if history.deposits.revisions.length}
				<ol class="m-0 flex list-none flex-col gap-2 p-0" data-testid="history-deposits">
					{#each [...history.deposits.revisions].reverse() as revision (revision.revision)}
						<li class="rounded-input bg-cream-200 px-3 py-2.5 text-[13px]">
							<span class="font-semibold">Deposit terms revision {revision.revision}</span>
							<span class="block text-[11.5px] text-(--text-muted)">
								{revision.state === 'ACTIVE'
									? `${formatMoney(revision.requiredAmount.amount, revision.requiredAmount.currency)} · ${depositTermsLabel(revision.terms)}`
									: 'Withdrawn'}
								· <time datetime={revision.createdAt}>{receivedTimeLabel(revision.createdAt)}</time>
							</span>
						</li>
					{/each}
				</ol>
			{/if}
		{:else if open}
			<p
				role="status"
				class="m-0 text-[13px] text-(--text-muted)"
				data-testid="history-unavailable"
			>
				Financial history is unavailable right now. The booking above is unaffected.
				<Button href={openHref} data-sveltekit-reload variant="ghost" size="sm">Try again</Button>
			</p>
		{:else}
			<p class="m-0 text-[12.5px] text-(--text-muted)">
				See every immutable financial version and deposit revision behind this booking.
			</p>
		{/if}
	</section>
</Card>
