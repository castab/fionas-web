type Turnstile = {
	render: (
		container: HTMLElement,
		options: {
			sitekey: string;
			theme: 'light';
			size: 'flexible';
			action: 'booking';
			callback: (token: string) => void;
			'expired-callback': () => void;
			'error-callback': () => void;
		}
	) => string;
	remove: (id: string) => void;
};

declare global {
	interface Window {
		turnstile?: Turnstile;
	}
}

let loading: Promise<void> | undefined;
export function loadTurnstile(): Promise<void> {
	if (window.turnstile) return Promise.resolve();
	if (!loading) {
		loading = new Promise<void>((resolve, reject) => {
			const script = document.createElement('script');
			script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
			script.async = true;
			script.onload = () => resolve();
			script.onerror = () => {
				script.remove();
				loading = undefined;
				reject(new Error('Security check unavailable'));
			};
			document.head.append(script);
		});
	}
	return loading;
}
