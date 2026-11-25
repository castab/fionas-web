<script lang="ts">
	import * as Dialog from './index.js';

	let { open = $bindable(false) }: { open?: boolean } = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Trigger>Open</Dialog.Trigger>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Remove this passkey?</Dialog.Title>
			<Dialog.Description>You can add it again later.</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Dialog.Close>Cancel</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
