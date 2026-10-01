<script lang="ts">
	import { Badge, Card } from '@fionas/ui';
	import { site } from '@fionas/shared';
</script>

<svelte:head>
	<title>Admin · {site.name}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-(--container-max) flex-col gap-6 px-8 py-14">
	<div class="flex flex-col items-start gap-3">
		<Badge>Coming soon</Badge>
		<h1 class="m-0 tracking-(--track-heading) text-(--text-heading) [font:var(--type-h1)]">
			Admin
		</h1>
		<p class="m-0 max-w-[60ch] text-(--text-muted)">
			Booking management, menu and calendar tools will live here once online booking launches.
		</p>
	</div>
	<Card variant="flat" class="max-w-[60ch]">
		<p class="m-0 text-(--text-muted) [font:var(--type-body-sm)]">Nothing to manage yet.</p>
	</Card>
</main>
