/**
 * Temporary sign-in feedback toast. It exists only to confirm login success/failure while the admin
 * console is brought up, and goes away once the session flow is trusted: delete this file,
 * `components/login-toast.svelte` and their uses.
 */
export type ToastTone = 'success' | 'error';

export type ToastState = { message: string; tone: ToastTone; key: number } | null;

const DISMISS_MS = 3200;

let current = $state<ToastState>(null);
let counter = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function show(message: string, tone: ToastTone) {
	clearTimeout(timer);
	current = { message, tone, key: ++counter };
	timer = setTimeout(dismiss, DISMISS_MS);
}

function dismiss() {
	clearTimeout(timer);
	current = null;
}

export const toast = {
	/** The toast being shown, if any. `key` changes on every call so repeats re-animate. */
	get current() {
		return current;
	},
	success: (message: string) => show(message, 'success'),
	error: (message: string) => show(message, 'error'),
	dismiss
};
