export type ComingSoonToastOptions = {
	title: string;
	description: string;
	actionLabel: string;
	/** External link for the action pill (opens in a new tab). */
	actionHref: string;
	timeoutMs: number;
};

type ComingSoonToastState = ComingSoonToastOptions & {
	visible: boolean;
	/** Bumped on every show() so the timer-bar animation restarts when an already-visible toast
	 * is re-triggered (repeat clicks reset it in place rather than stacking). */
	updateKey: number;
};

const state = $state<ComingSoonToastState>({
	visible: false,
	updateKey: 0,
	title: '',
	description: '',
	actionLabel: '',
	actionHref: '',
	timeoutMs: 0
});

let dismissAt = 0;
let remainingMs = 0;
let dismissTimer: ReturnType<typeof setTimeout> | undefined;

function clearDismissTimer() {
	clearTimeout(dismissTimer);
	dismissTimer = undefined;
}

function scheduleDismiss() {
	dismissAt = Date.now() + remainingMs;
	dismissTimer = setTimeout(() => {
		dismissTimer = undefined;
		state.visible = false;
	}, remainingMs);
}

export function comingSoonToastState(): Readonly<ComingSoonToastState> {
	return state;
}

export function showComingSoonToast(options: ComingSoonToastOptions) {
	clearDismissTimer();
	Object.assign(state, options);
	state.visible = true;
	state.updateKey += 1;
	remainingMs = options.timeoutMs;
	if (remainingMs > 0) scheduleDismiss();
}

export function dismissComingSoonToast() {
	clearDismissTimer();
	state.visible = false;
}

/** Hovering or focusing the toast pauses auto-dismiss (the timer bar pauses in CSS too), so a
 * visitor reading the message doesn't have it vanish mid-read. */
export function pauseComingSoonToast() {
	if (!state.visible || !dismissTimer) return;
	clearDismissTimer();
	remainingMs = Math.max(0, dismissAt - Date.now());
}

export function resumeComingSoonToast() {
	if (!state.visible || dismissTimer || remainingMs <= 0) return;
	scheduleDismiss();
}
