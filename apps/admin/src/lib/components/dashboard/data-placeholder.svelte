<script lang="ts">
	import { capsXs } from '@fionas/ui';

	/**
	 * Holds the spot of a dashboard block the API can't power yet. `needs` names the missing data;
	 * the full write-up is docs/admin-dashboard-report.md.
	 */
	let {
		title,
		needs,
		class: className
	}: { title: string; needs: string; class?: string } = $props();
</script>

<div
	data-testid="data-placeholder"
	class={[
		'flex flex-col gap-1 rounded-card border border-dashed border-olive-300 bg-cream-100/60 px-4 py-3.5',
		className
	]}
>
	<span class={`text-olive-600 ${capsXs}`}>Placeholder · {title}</span>
	<p class="m-0 font-sans text-[12.5px] leading-[1.5] text-(--text-muted)">Needs: {needs}</p>
</div>
