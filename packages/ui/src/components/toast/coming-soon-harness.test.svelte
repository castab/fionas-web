<script lang="ts">
	import ComingSoonButton from './coming-soon-button.svelte';
	import ComingSoonToast from './coming-soon-toast.svelte';
	import type { ComingSoonToastOptions } from './coming-soon-toast-state.svelte.js';

	let { toast }: { toast: ComingSoonToastOptions } = $props();
</script>

<ComingSoonButton {toast}>Book</ComingSoonButton>
<ComingSoonToast />
