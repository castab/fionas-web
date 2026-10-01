<script lang="ts">
	import './layout.css';
	import favicon from '@fionas/ui/assets/logo-badge.svg';
	import LoginToast from '$lib/components/login-toast.svelte';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

{@render children()}

<LoginToast />
