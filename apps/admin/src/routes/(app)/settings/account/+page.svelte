<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { Badge, Button, Card, Dialog, Field, Input } from '@fionas/ui';
	import { site } from '@fionas/shared';
	import { submittedDateLabel } from '$lib/presentation.js';
	import { roleLabel, staffHandle } from '$lib/staff.js';
	import { passkeyProvider, type ProviderKind } from '$lib/passkey-providers.js';
	import {
		PASSKEY_LIMIT,
		PASSKEY_NAME_MAX,
		PASSWORD_MIN,
		normalizePasskeyName,
		type Passkey
	} from '$lib/passkeys.js';
	import {
		createPasskey,
		readPasskeys,
		reauthenticateWithPassword,
		removePasskey,
		renamePasskey,
		signInWithPasskey,
		signalAcceptedCredentials,
		supportsPasskeys
	} from '$lib/passkey-client.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const profile = $derived({
		displayName: data.account?.displayName ?? data.user.displayName,
		username: data.account?.username ?? data.user.username,
		roles: data.account?.roles ?? data.user.roles
	});

	// The server's list, replaced in place after every change on this page.
	let list = $derived(data.passkeys);
	const passkeys = $derived(list?.passkeys ?? []);
	let supported = $state(true);
	let status = $state('');

	onMount(() => {
		supported = supportsPasskeys();
	});

	async function refresh() {
		const result = await readPasskeys();
		if (result.ok) list = result.data;
		return result.ok ? result.data : null;
	}

	// --- Create ---------------------------------------------------------------------------------
	let creating = $state(false);
	let createError = $state<string | null>(null);

	async function create({ retry = false }: { retry?: boolean } = {}) {
		if (creating) return;
		creating = true;
		createError = null;
		const outcome = await createPasskey();
		creating = false;
		if (outcome.ok) {
			await refresh();
			status = 'Passkey created.';
			return;
		}
		if (outcome.failure?.code === 'reauthentication_required') {
			askToConfirm({ kind: 'create' });
			return;
		}
		if (outcome.failure) createError = outcome.failure.message;
		// Some browsers allow only one passkey prompt per click; the confirmation just used it.
		else if (retry) createError = 'You’re confirmed. Choose Create a passkey again to finish.';
	}

	// --- Rename ---------------------------------------------------------------------------------
	let editingId = $state<string | null>(null);
	let editName = $state('');
	let renameError = $state<string | null>(null);
	let renaming = $state(false);

	async function startRename(passkey: Passkey) {
		editingId = passkey.id;
		editName = passkey.name ?? passkeyProvider(passkey.aaguid).name;
		renameError = null;
		await tick();
		document.getElementById(`rename-${passkey.id}`)?.focus();
	}

	async function saveRename(passkey: Passkey) {
		const name = normalizePasskeyName(editName);
		if (name === undefined) {
			renameError = `Use up to ${PASSKEY_NAME_MAX} characters, without special characters.`;
			return;
		}
		renaming = true;
		const outcome = await renamePasskey(passkey.id, name);
		renaming = false;
		if (!outcome.ok) {
			renameError = outcome.failure?.message ?? null;
			return;
		}
		if (list)
			list = {
				...list,
				passkeys: list.passkeys.map((p) => (p.id === passkey.id ? outcome.data : p))
			};
		editingId = null;
		status = 'Passkey renamed.';
	}

	// --- Remove ---------------------------------------------------------------------------------
	let removeTarget = $state<Passkey | null>(null);
	let removeOpen = $state(false);
	let removing = $state(false);
	let removeError = $state<string | null>(null);

	function confirmRemove(passkey: Passkey) {
		removeTarget = passkey;
		removeError = null;
		removeOpen = true;
	}

	async function remove(passkey: Passkey) {
		removing = true;
		removeError = null;
		const outcome = await removePasskey(passkey.id);
		removing = false;
		if (!outcome.ok && outcome.failure?.code === 'reauthentication_required') {
			removeOpen = false;
			askToConfirm({ kind: 'remove', passkey });
			return;
		}
		if (!outcome.ok && outcome.failure?.code !== 'not_found') {
			removeError = outcome.failure?.message ?? null;
			removeOpen = true;
			return;
		}
		removeOpen = false;
		const fresh = await refresh();
		status = 'Passkey removed.';
		// Lets password managers hide the passkey this site no longer accepts.
		if (fresh) await signalAcceptedCredentials(fresh);
	}

	// --- Confirm it's you -----------------------------------------------------------------------
	type Pending = { kind: 'create' } | { kind: 'remove'; passkey: Passkey };
	let pending: Pending | null = null;
	let reauthOpen = $state(false);
	let reauthBusy = $state(false);
	let reauthPassword = $state('');
	let reauthError = $state<string | null>(null);

	function askToConfirm(action: Pending) {
		pending = action;
		reauthPassword = '';
		reauthError = null;
		reauthOpen = true;
	}

	async function confirmed() {
		reauthOpen = false;
		reauthPassword = '';
		const action = pending;
		pending = null;
		if (action?.kind === 'create') await create({ retry: true });
		else if (action?.kind === 'remove') await remove(action.passkey);
	}

	async function reauthWithPasskey() {
		reauthBusy = true;
		reauthError = null;
		const outcome = await signInWithPasskey();
		reauthBusy = false;
		if (outcome.ok) await confirmed();
		else if (outcome.failure) reauthError = outcome.failure.message;
	}

	async function reauthWithPassword(event: SubmitEvent) {
		event.preventDefault();
		if (!reauthPassword) {
			reauthError = 'Enter your password.';
			return;
		}
		reauthBusy = true;
		reauthError = null;
		const outcome = await reauthenticateWithPassword(reauthPassword);
		reauthBusy = false;
		if (outcome.ok) await confirmed();
		else if (outcome.failure) reauthError = outcome.failure.message;
	}

	// --- Password -------------------------------------------------------------------------------
	let changingPassword = $state(false);
	const passwordResult = $derived(form?.password);
	const passwordError = $derived(
		passwordResult && 'error' in passwordResult ? passwordResult : null
	);
	const fieldError = (field: 'current' | 'new' | 'confirm') =>
		passwordError?.field === field ? passwordError.error : undefined;

	const caps =
		'm-0 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-heading) uppercase';
	const note = 'm-0 text-[13px] leading-[1.55] text-(--text-muted)';
	const body = 'm-0 text-sm leading-[1.55] text-(--text-body)';
	const atLimit = $derived(passkeys.length >= PASSKEY_LIMIT);
</script>

<svelte:head><title>Account settings · Admin · {site.name}</title></svelte:head>

{#snippet providerIcon(kind: ProviderKind)}
	<span
		class="flex size-10 flex-none items-center justify-center rounded-full bg-olive-100 text-olive-800"
		aria-hidden="true"
	>
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			{#if kind === 'platform'}
				<rect x="3" y="4" width="18" height="12" rx="2"></rect>
				<path d="M2 20h20"></path>
			{:else if kind === 'security-key'}
				<rect x="7" y="2" width="10" height="20" rx="3"></rect>
				<circle cx="12" cy="8" r="2"></circle>
			{:else}
				<circle cx="7.5" cy="15.5" r="5.5"></circle>
				<path d="m21 2-9.6 9.6"></path>
				<path d="m15.5 7.5 3 3L22 7l-3-3"></path>
			{/if}
		</svg>
	</span>
{/snippet}

<div class="mx-auto flex w-full max-w-[760px] flex-col gap-5 pb-8">
	<header class="flex flex-col gap-1">
		<h1
			class="m-0 font-sans text-[1.75rem] leading-[1.2] font-bold tracking-(--track-heading) text-(--text-heading)"
		>
			Account settings
		</h1>
		<p class="m-0 font-sans text-sm leading-[1.55] text-(--text-muted)">
			Your profile, how you sign in, and your password.
		</p>
	</header>

	<p class="sr-only" role="status">{status}</p>

	<Card
		variant="flat"
		class="flex flex-col gap-3 p-[18px]"
		role="region"
		aria-labelledby="profile-title"
		data-testid="profile"
	>
		<h2 id="profile-title" class={caps}>Profile</h2>
		<dl class="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
			<dt class="text-(--text-muted)">Name</dt>
			<dd class="m-0 font-semibold text-(--text-heading)">{profile.displayName}</dd>
			<dt class="text-(--text-muted)">Username</dt>
			<dd class="m-0 text-(--text-body)">{staffHandle(profile)}</dd>
			<dt class="text-(--text-muted)">Role</dt>
			<dd class="m-0 text-(--text-body)">{roleLabel(profile.roles)}</dd>
		</dl>
		<p class={note}>Ask an administrator to change your name or role.</p>
	</Card>

	<Card
		variant="flat"
		class="flex flex-col gap-3 p-[18px]"
		role="region"
		aria-labelledby="passkeys-title"
		data-testid="passkeys"
	>
		<div class="flex flex-wrap items-center justify-between gap-2">
			<h2 id="passkeys-title" class={caps}>Passkeys</h2>
			{#if supported && list}
				<Button
					size="sm"
					onclick={() => create()}
					disabled={creating || atLimit}
					data-testid="create-passkey"
				>
					{creating ? 'Creating…' : 'Create a passkey'}
				</Button>
			{/if}
		</div>

		{#if !supported}
			<p class={body}>This browser can’t use passkeys. You can still sign in with your password.</p>
		{/if}

		{#if list === null}
			<p class={note}>Your passkeys couldn’t load. Reload the page to try again.</p>
		{:else if passkeys.length === 0}
			<p class={body} data-testid="no-passkeys">
				A passkey lets you sign in with your fingerprint, face, or screen lock instead of a
				password. It’s saved by your password manager or device, and it can’t be phished or guessed.
			</p>
		{:else}
			<ul class="m-0 flex list-none flex-col divide-y divide-(--border-soft) p-0">
				{#each passkeys as passkey (passkey.id)}
					{@render passkeyRow(passkey)}
				{/each}
			</ul>
			<p class={note}>Your password still works if you lose your passkeys.</p>
		{/if}
		{#if atLimit}
			<p class={note}>You can have up to {PASSKEY_LIMIT} passkeys. Remove one to add another.</p>
		{/if}
		{#if createError}
			<p role="alert" class="m-0 text-sm text-rust-600" data-testid="create-error">
				{createError}
			</p>
		{/if}
	</Card>

	<Card
		variant="flat"
		class="flex flex-col gap-3 p-[18px]"
		role="region"
		aria-labelledby="password-title"
		data-testid="password"
	>
		<h2 id="password-title" class={caps}>Password</h2>
		<p class={note}>
			Use at least {PASSWORD_MIN} characters. A few unrelated words make a strong password. Changing it
			signs you out everywhere else.
		</p>
		<form
			method="POST"
			action="?/password"
			novalidate
			class="flex max-w-[400px] flex-col gap-4"
			use:enhance={() => {
				changingPassword = true;
				return async ({ result, update }) => {
					await update({ reset: result.type === 'success' });
					changingPassword = false;
				};
			}}
		>
			<!-- For password managers: which account this password belongs to. -->
			<input
				type="text"
				name="username"
				autocomplete="username"
				value={profile.username}
				readonly
				tabindex="-1"
				aria-hidden="true"
				class="sr-only"
			/>
			<Field label="Current password" error={fieldError('current')}>
				{#snippet children({ id, describedby, invalid })}
					<Input
						{id}
						name="currentPassword"
						type="password"
						autocomplete="current-password"
						required
						aria-describedby={describedby}
						aria-invalid={invalid || undefined}
					/>
				{/snippet}
			</Field>
			<Field
				label="New password"
				description={`At least ${PASSWORD_MIN} characters.`}
				error={fieldError('new')}
			>
				{#snippet children({ id, describedby, invalid })}
					<Input
						{id}
						name="newPassword"
						type="password"
						autocomplete="new-password"
						minlength={PASSWORD_MIN}
						required
						aria-describedby={describedby}
						aria-invalid={invalid || undefined}
					/>
				{/snippet}
			</Field>
			<Field label="Confirm new password" error={fieldError('confirm')}>
				{#snippet children({ id, describedby, invalid })}
					<Input
						{id}
						name="confirmPassword"
						type="password"
						autocomplete="new-password"
						required
						aria-describedby={describedby}
						aria-invalid={invalid || undefined}
					/>
				{/snippet}
			</Field>
			{#if passwordError && !passwordError.field}
				<p role="alert" class="m-0 text-sm text-rust-600">{passwordError.error}</p>
			{/if}
			{#if passwordResult && 'changed' in passwordResult}
				<p role="status" class="m-0 text-sm text-moss-600" data-testid="password-changed">
					Password changed. Other devices were signed out.
				</p>
			{/if}
			<div>
				<Button type="submit" size="sm" disabled={changingPassword}>
					{changingPassword ? 'Changing…' : 'Change password'}
				</Button>
			</div>
		</form>
	</Card>
</div>

{#snippet passkeyRow(passkey: Passkey)}
	{@const provider = passkeyProvider(passkey.aaguid)}
	<li class="flex flex-wrap items-center gap-3 py-3" data-testid="passkey">
		{@render providerIcon(provider.kind)}
		<div class="flex min-w-0 flex-1 flex-col gap-1">
			{#if editingId === passkey.id}
				<form
					class="flex flex-wrap items-start gap-2"
					onsubmit={(event) => {
						event.preventDefault();
						void saveRename(passkey);
					}}
				>
					<label for={`rename-${passkey.id}`} class="sr-only">Passkey name</label>
					<Input
						id={`rename-${passkey.id}`}
						bind:value={editName}
						maxlength={PASSKEY_NAME_MAX}
						autocomplete="off"
						class="max-w-[280px] py-1.5"
						aria-invalid={renameError ? true : undefined}
						onkeydown={(event) => {
							if (event.key === 'Escape') editingId = null;
						}}
					/>
					<Button type="submit" size="sm" disabled={renaming}>Save</Button>
					<Button size="sm" variant="ghost" onclick={() => (editingId = null)}>Cancel</Button>
				</form>
				{#if renameError}
					<p role="alert" class="m-0 text-[12.5px] text-rust-600">{renameError}</p>
				{/if}
			{:else}
				<div class="flex flex-wrap items-center gap-2">
					<span
						class="text-sm font-bold wrap-anywhere text-(--text-heading)"
						data-testid="passkey-name"
					>
						{passkey.name ?? provider.name}
					</span>
					{#if passkey.backedUp}
						<Badge size="sm" tone="moss">Synced</Badge>
					{/if}
				</div>
			{/if}
			<span class="text-[12.5px] leading-[1.5] text-(--text-muted)">
				{#if passkey.name && provider.kind !== 'unknown'}{provider.name} ·
				{/if}Created {submittedDateLabel(passkey.createdAt)} · {passkey.lastUsedAt
					? `Last used ${submittedDateLabel(passkey.lastUsedAt)}`
					: 'Not used yet'}
			</span>
		</div>
		{#if editingId !== passkey.id}
			<div class="flex gap-1">
				<Button
					size="sm"
					variant="ghost"
					onclick={() => startRename(passkey)}
					aria-label={`Rename ${passkey.name ?? provider.name}`}
					data-testid="rename-passkey"
				>
					Rename
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onclick={() => confirmRemove(passkey)}
					aria-label={`Remove ${passkey.name ?? provider.name}`}
					data-testid="remove-passkey"
				>
					Remove
				</Button>
			</div>
		{/if}
	</li>
{/snippet}

<Dialog.Root bind:open={removeOpen}>
	<Dialog.Content data-testid="remove-dialog">
		<Dialog.Header>
			<Dialog.Title>Remove this passkey?</Dialog.Title>
			<Dialog.Description>
				{#if passkeys.length === 1}
					It’s your only passkey. You’ll sign in with your password.
				{:else}
					You won’t be able to sign in with it anymore. Your other passkeys keep working.
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		{#if removeError}
			<p role="alert" class="m-0 text-sm text-rust-600">{removeError}</p>
		{/if}
		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}
					<Button {...props} size="sm" variant="ghost">Cancel</Button>
				{/snippet}
			</Dialog.Close>
			<Button
				size="sm"
				disabled={removing}
				onclick={() => removeTarget && remove(removeTarget)}
				data-testid="confirm-remove"
			>
				{removing ? 'Removing…' : 'Remove passkey'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={reauthOpen}>
	<Dialog.Content data-testid="reauth-dialog">
		<Dialog.Header>
			<Dialog.Title>Confirm it’s you</Dialog.Title>
			<Dialog.Description>
				To change your passkeys, confirm it’s you. You signed in more than 10 minutes ago.
			</Dialog.Description>
		</Dialog.Header>
		{#if supported && passkeys.length > 0}
			<Button
				variant="secondary"
				size="sm"
				onclick={reauthWithPasskey}
				disabled={reauthBusy}
				data-testid="reauth-passkey"
			>
				Use a passkey
			</Button>
			<div class="flex items-center gap-3" aria-hidden="true">
				<span class="h-px flex-1 bg-(--border-soft)"></span>
				<span class="font-sans text-xs text-(--text-muted)">or use your password</span>
				<span class="h-px flex-1 bg-(--border-soft)"></span>
			</div>
		{/if}
		<form class="flex flex-col gap-3" onsubmit={reauthWithPassword} novalidate>
			<Field label="User">
				{#snippet children({ id, describedby })}
					<Input
						{id}
						name="username"
						autocomplete="username"
						value={profile.username}
						readonly
						aria-describedby={describedby}
					/>
				{/snippet}
			</Field>
			<Field label="Password">
				{#snippet children({ id, describedby })}
					<Input
						{id}
						name="password"
						type="password"
						autocomplete="current-password"
						bind:value={reauthPassword}
						aria-describedby={describedby}
						aria-invalid={reauthError ? true : undefined}
					/>
				{/snippet}
			</Field>
			{#if reauthError}
				<p role="alert" class="m-0 text-sm text-rust-600" data-testid="reauth-error">
					{reauthError}
				</p>
			{/if}
			<Dialog.Footer>
				<Button type="submit" size="sm" disabled={reauthBusy} data-testid="reauth-confirm">
					{reauthBusy ? 'Confirming…' : 'Confirm'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
