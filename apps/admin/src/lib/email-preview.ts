/**
 * The preview document for commerce's backend-rendered email HTML. The admin never injects it into
 * its own DOM. It is shown in an `<iframe sandbox="">` (opaque origin: no scripts, forms, popups,
 * plugins or top navigation) and this document adds its own policy as defense in depth:
 *
 * - `default-src 'none'`: no scripts, fonts, frames, connections or remote stylesheets;
 * - `img-src data:`: no remote images, so the preview makes no network requests (privacy);
 * - `form-action 'none'`, `base-uri 'none'`, and every link targets a new window, which the sandbox
 *   blocks (no `allow-popups`): own `target` attributes are removed, so a click, including on the
 *   inert `https://example.invalid/payment-preview` button, goes nowhere and the preview stays put;
 * - `<meta http-equiv="refresh">` is removed, so the frame cannot navigate itself.
 *
 * The admin response also sends `frame-src 'none'`, so the frame cannot be navigated to any URL.
 */
export const PREVIEW_POLICY =
	"default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";

export function previewDocument(html: string): string {
	const head =
		'<base target="_blank">' +
		`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}">` +
		'<meta name="referrer" content="no-referrer">';
	let inert = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, '');
	const target = /(<[a-z][^>]*?)\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi;
	for (let previous = ''; previous !== inert;) {
		previous = inert;
		inert = inert.replace(target, '$1');
	}
	const open = /<head\b[^>]*>/i.exec(inert);
	if (open) {
		const at = open.index + open[0].length;
		return inert.slice(0, at) + head + inert.slice(at);
	}
	return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${inert}</body></html>`;
}
