<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Badge, Button, Card, Field, Input } from '@fionas/ui';
	import { site } from '@fionas/shared';
	import { submittedDateLabel } from '$lib/presentation.js';
	import {
		LABEL_MAX,
		isTerminal,
		normalizeLabel,
		serviceLabel,
		testStatusCopy,
		type PushDevice,
		type TestNotification,
		type TestStatus
	} from '$lib/notifications.js';
	import {
		browserTraits,
		defaultDeviceLabel,
		enableThisDevice,
		pushSupport,
		readDevices,
		readTest,
		removeDevice,
		sendTest,
		syncThisDevice
	} from '$lib/push-client.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const push = $derived(data.push);
	const vapidPublicKey = $derived(push.state === 'enabled' ? push.vapidPublicKey : null);

	type ThisDevice =
		| { kind: 'checking' }
		| { kind: 'unsupported' | 'ios-install' | 'ios-update' | 'blocked' | 'off' | 'error' }
		| { kind: 'on'; subscriptionId: string; label: string | null };

	let device = $state<ThisDevice>({ kind: 'checking' });
	let label = $state('');
	let enabling = $state(false);
	let enableError = $state<string | null>(null);
	let nameError = $state<string | null>(null);

	// The server's list, replaced in place after every change on this page.
	let devices = $derived(push.state === 'enabled' ? push.devices : null);
	let removing = $state<string | null>(null);
	let removeError = $state<string | null>(null);

	type TestRun =
		| { phase: 'sending' }
		| { phase: 'tracking'; status: TestStatus; failureReason: string | null }
		| { phase: 'done'; test: TestNotification }
		| { phase: 'stalled' }
		| { phase: 'uncertain' }
		| { phase: 'failed'; message: string };
	let test = $state<TestRun | null>(null);
	let appeared = $state<'yes' | 'no' | null>(null);
	/** One key per click; kept only while that click's outcome is unknown, so "Try again" reuses it. */
	let testKey: string | null = null;
	/** Bumped to abandon an in-flight poll (a new test, a removal, leaving the page). */
	let pollToken = 0;

	let thisDeviceHeading = $state<HTMLHeadingElement | null>(null);
	const thisDeviceId = $derived(device.kind === 'on' ? device.subscriptionId : null);
	const thisDeviceLabel = $derived(device.kind === 'on' ? device.label : null);

	onMount(() => {
		if (push.state !== 'enabled') return;
		const traits = browserTraits();
		label = defaultDeviceLabel(traits);
		const support = pushSupport(traits);
		if (support !== 'supported') {
			device = { kind: support };
			return;
		}
		if (Notification.permission === 'denied') {
			device = { kind: 'blocked' };
			return;
		}
		let active = true;
		void syncThisDevice().then(async (result) => {
			if (!active) return;
			if (result.kind === 'enrolled') {
				device = { kind: 'on', ...result.device };
				// A fresh enrollment (say, after a remote removal) may be missing from the server list.
				if (!devices?.some((d) => d.subscriptionId === result.device.subscriptionId))
					await refreshDevices();
			} else device = { kind: result.kind === 'unavailable' ? 'error' : 'off' };
		});
		return () => {
			active = false;
			pollToken++;
		};
	});

	async function refreshDevices() {
		const result = await readDevices();
		if (result.ok) devices = result.devices;
	}

	async function enable() {
		if (!vapidPublicKey || enabling) return;
		enableError = null;
		nameError = null;
		const name = normalizeLabel(label);
		if (name === undefined) {
			nameError = `Use a device name of up to ${LABEL_MAX} characters, without special characters.`;
			return;
		}
		enabling = true;
		// Called straight from the click: the permission prompt needs the user gesture.
		const outcome = await enableThisDevice(vapidPublicKey, name);
		enabling = false;
		if (outcome.ok) {
			device = { kind: 'on', ...outcome.device };
			test = null;
			testKey = null;
			await refreshDevices();
		} else if (outcome.reason === 'blocked') device = { kind: 'blocked' };
		else if (outcome.reason === 'dismissed')
			enableError = 'Notifications weren’t allowed. Choose Allow when your browser asks.';
		else if (outcome.reason === 'subscribe-failed')
			enableError = 'This browser couldn’t set up push notifications. Try again.';
		else if ('failure' in outcome) enableError = outcome.failure.message;
	}

	async function remove(subscriptionId: string) {
		if (removing) return;
		removing = subscriptionId;
		removeError = null;
		const isThis = subscriptionId === thisDeviceId;
		const outcome = await removeDevice(subscriptionId, isThis);
		removing = null;
		if (!outcome.ok) {
			removeError = outcome.failure.message;
			return;
		}
		if (isThis) {
			device = { kind: 'off' };
			test = null;
			testKey = null;
			pollToken++;
			await tick();
			thisDeviceHeading?.focus();
		}
		if (devices) devices = devices.filter((d) => d.subscriptionId !== subscriptionId);
		await refreshDevices();
	}

	async function startTest() {
		if (device.kind !== 'on' || test?.phase === 'sending' || test?.phase === 'tracking') return;
		const subscriptionId = device.subscriptionId;
		testKey ??= crypto.randomUUID();
		const key = testKey;
		const token = ++pollToken;
		test = { phase: 'sending' };
		appeared = null;
		const outcome = await sendTest(subscriptionId, key);
		if (token !== pollToken) return;
		if (!outcome.ok) {
			if (outcome.failure.code === 'unavailable') {
				test = { phase: 'uncertain' };
				return;
			}
			testKey = null;
			test = { phase: 'failed', message: outcome.failure.message };
			return;
		}
		testKey = null;
		await track(outcome.queued.notificationId, token, outcome.queued.status);
	}

	/** Polls about every two seconds for up to a minute, until the status is terminal. */
	async function track(notificationId: string, token: number, status: TestStatus) {
		test = { phase: 'tracking', status, failureReason: null };
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 2000));
			if (token !== pollToken) return;
			const read = await readTest(notificationId);
			if (token !== pollToken) return;
			if (read.ok) {
				if (isTerminal(read.test.status)) {
					test = { phase: 'done', test: read.test };
					return;
				}
				test = {
					phase: 'tracking',
					status: read.test.status,
					failureReason: read.test.failureReason
				};
			} else if (read.failure.code !== 'unavailable') {
				test = { phase: 'failed', message: read.failure.message };
				return;
			}
		}
		test = { phase: 'stalled' };
	}

	const caps =
		'm-0 font-sans text-[11px] leading-[1.4] font-semibold tracking-(--track-caps-tight) text-(--text-heading) uppercase';
	const note = 'm-0 text-[13px] leading-[1.55] text-(--text-muted)';
	const body = 'm-0 text-sm leading-[1.55] text-(--text-body)';
	const testBusy = $derived(test?.phase === 'sending' || test?.phase === 'tracking');
</script>

<svelte:head><title>Notifications · Admin · {site.name}</title></svelte:head>

<div class="mx-auto flex w-full max-w-[760px] flex-col gap-5 pb-8">
	<header class="flex flex-col gap-1">
		<h1
			class="m-0 font-sans text-[1.75rem] leading-[1.2] font-bold tracking-(--track-heading) text-(--text-heading)"
		>
			Notifications
		</h1>
		<p class="m-0 font-sans text-sm leading-[1.55] text-(--text-muted)">
			Get a push notification on this device when a new catering request comes in. Each browser or
			installed app you use is enrolled on its own.
		</p>
	</header>

	{#if push.state === 'disabled'}
		<Card variant="flat" class="flex flex-col gap-2 p-[18px]" data-testid="push-disabled">
			<h2 class={caps}>Push notifications aren’t available yet</h2>
			<p class={note}>
				Once they’re turned on for Fiona’s admin, you can enable them for this device here.
			</p>
		</Card>
	{:else if push.state === 'unavailable'}
		<Card variant="flat" class="flex flex-col gap-2 p-[18px]" data-testid="push-unavailable">
			<h2 class={caps}>Notification settings couldn’t load</h2>
			<p class={note}>Reload the page to try again.</p>
		</Card>
	{:else}
		<Card
			variant="flat"
			class="flex flex-col gap-3 p-[18px]"
			role="region"
			aria-labelledby="this-device-title"
			data-testid="this-device"
		>
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h2 id="this-device-title" class={caps} tabindex="-1" bind:this={thisDeviceHeading}>
					This device
				</h2>
				{#if device.kind === 'on'}
					<Badge size="sm" tone="moss" data-testid="this-device-status">Notifications on</Badge>
				{:else if device.kind === 'off'}
					<Badge size="sm" tone="outline" data-testid="this-device-status">Notifications off</Badge>
				{/if}
			</div>

			{#if device.kind === 'checking'}
				<p class={note}>Checking this browser…</p>
			{:else if device.kind === 'unsupported'}
				<p class={body}>
					This browser can’t receive push notifications. Try a current version of Chrome, Edge,
					Firefox or Safari.
				</p>
			{:else if device.kind === 'ios-install'}
				<div class="flex flex-col gap-1.5" data-testid="ios-install">
					<p class={body}>
						On iPhone and iPad, notifications only work from the Home Screen app. Add Fiona’s Admin
						to your Home Screen first.
					</p>
					<p class={note}>
						In Safari, tap Share, then Add to Home Screen. Open Fiona’s Admin from your Home Screen
						and come back to this page.
					</p>
				</div>
			{:else if device.kind === 'ios-update'}
				<p class={body}>Update to iOS or iPadOS 16.4 or later to get notifications here.</p>
			{:else if device.kind === 'blocked'}
				<p class={body} data-testid="push-blocked">
					Notifications are blocked for this site. Allow them in your browser’s site settings, then
					reload this page.
				</p>
			{:else if device.kind === 'error'}
				<p class={body} role="alert">Couldn’t check this device. Reload the page to try again.</p>
			{:else if device.kind === 'off'}
				<p class={note}>
					Your browser will ask for permission. You can name this device so you can tell your
					devices apart.
				</p>
				<Field
					label="Device name"
					description="Optional."
					error={nameError ?? undefined}
					class="max-w-[360px]"
				>
					{#snippet children({ id, describedby, invalid })}
						<Input
							{id}
							aria-describedby={describedby}
							aria-invalid={invalid || undefined}
							bind:value={label}
							maxlength={LABEL_MAX}
							autocomplete="off"
						/>
					{/snippet}
				</Field>
				<div>
					<Button size="sm" onclick={enable} disabled={enabling} data-testid="enable-push">
						{enabling ? 'Enabling…' : 'Enable notifications'}
					</Button>
				</div>
				{#if enableError}
					<p role="alert" class="m-0 text-sm text-rust-600" data-testid="enable-error">
						{enableError}
					</p>
				{/if}
			{:else}
				<p class={body} data-testid="this-device-label">
					Notifications are on for <strong>{thisDeviceLabel ?? 'this device'}</strong>.
				</p>
				<div class="flex flex-wrap gap-2">
					<Button
						size="sm"
						onclick={startTest}
						disabled={testBusy || test?.phase === 'uncertain'}
						data-testid="send-test"
					>
						{testBusy ? 'Sending test…' : 'Send test'}
					</Button>
					<Button
						size="sm"
						variant="secondary"
						onclick={() => thisDeviceId && remove(thisDeviceId)}
						disabled={removing !== null}
						data-testid="turn-off"
					>
						Turn off on this device
					</Button>
				</div>
				<!-- Always in the page, so the first status is announced; the buttons sit outside it. -->
				<div
					class={test ? 'flex flex-col items-start gap-2 rounded-input bg-cream-200 p-3' : ''}
					data-testid="test-status"
				>
					<div role="status" class="flex flex-col gap-2">
						{#if test?.phase === 'sending'}
							<p class={body}>Sending a test to this device…</p>
						{:else if test?.phase === 'tracking'}
							<p class={body}>{testStatusCopy(test)}</p>
						{:else if test?.phase === 'uncertain'}
							<p class={body}>
								We couldn’t confirm the test was queued. Try again; it won’t be sent twice.
							</p>
						{:else if test?.phase === 'stalled'}
							<p class={body}>
								No answer from the push service after a minute. The test may still arrive; you can
								send another one later.
							</p>
						{:else if test?.phase === 'failed'}
							<p class="m-0 text-sm text-rust-600">{test.message}</p>
						{:else if test?.phase === 'done'}
							<p class={body} data-testid="test-outcome">{testStatusCopy(test.test)}</p>
							{#if test.test.status === 'push_accepted' && appeared === 'yes'}
								<p class={note}>Great. This device is ready for new request notifications.</p>
							{:else if test.test.status === 'push_accepted' && appeared === 'no'}
								<p class={note}>
									Check that notifications for this browser are allowed in your system settings and
									that Focus or Do Not Disturb is off, then send another test.
								</p>
							{/if}
						{/if}
					</div>
					{#if test?.phase === 'uncertain'}
						<Button size="sm" variant="secondary" onclick={startTest} data-testid="retry-test">
							Try again
						</Button>
					{:else if test?.phase === 'done' && test.test.status === 'push_accepted' && appeared === null}
						<div role="group" aria-labelledby="appeared-question" class="flex flex-col gap-2">
							<p id="appeared-question" class="m-0 text-sm font-semibold text-(--text-heading)">
								Did it appear?
							</p>
							<div class="flex gap-2">
								<Button size="sm" variant="secondary" onclick={() => (appeared = 'yes')}>Yes</Button
								>
								<Button size="sm" variant="ghost" onclick={() => (appeared = 'no')}>No</Button>
							</div>
						</div>
					{/if}
				</div>
			{/if}
		</Card>

		<Card
			variant="flat"
			class="flex flex-col gap-3 p-[18px]"
			role="region"
			aria-labelledby="devices-title"
			data-testid="devices"
		>
			<h2 id="devices-title" class={caps}>Your devices</h2>
			{#if devices === null}
				<p class={note}>Your devices couldn’t load. Reload the page to try again.</p>
			{:else if devices.length === 0}
				<p class={note} data-testid="no-devices">No devices are enrolled yet.</p>
			{:else}
				<ul class="m-0 flex list-none flex-col divide-y divide-(--border-soft) p-0">
					{#each devices as entry (entry.subscriptionId)}
						{@render deviceRow(entry)}
					{/each}
				</ul>
			{/if}
			{#if removeError}
				<p role="alert" class="m-0 text-sm text-rust-600">{removeError}</p>
			{/if}
		</Card>
	{/if}
</div>

{#snippet deviceRow(entry: PushDevice)}
	<li class="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="device">
		<div class="flex min-w-0 flex-col gap-1">
			<div class="flex flex-wrap items-center gap-2">
				<span
					class="text-sm font-bold wrap-anywhere text-(--text-heading)"
					data-testid="device-label"
				>
					{entry.label ?? 'Unnamed device'}
				</span>
				{#if entry.subscriptionId === thisDeviceId}
					<Badge size="sm" tone="inverse">This device</Badge>
				{/if}
				<Badge
					size="sm"
					tone={entry.state === 'ACTIVE' ? 'olive' : 'rust'}
					data-testid="device-state"
				>
					{entry.state === 'ACTIVE' ? 'Active' : 'Expired'}
				</Badge>
			</div>
			<span class="text-[12.5px] leading-[1.5] text-(--text-muted)">
				{serviceLabel(entry.service)} · Enrolled {submittedDateLabel(entry.enrolledAt)} · Last seen
				{submittedDateLabel(entry.refreshedAt)}
			</span>
			{#if entry.state === 'EXPIRED'}
				<span class="text-[12.5px] leading-[1.5] text-(--text-muted)">
					Its push subscription expired. Turn notifications on again on that device.
				</span>
			{/if}
		</div>
		<Button
			size="sm"
			variant="ghost"
			onclick={() => remove(entry.subscriptionId)}
			disabled={removing !== null}
			aria-label={`Remove ${entry.label ?? 'unnamed device'}`}
			data-testid="remove-device"
		>
			{removing === entry.subscriptionId ? 'Removing…' : 'Remove'}
		</Button>
	</li>
{/snippet}
