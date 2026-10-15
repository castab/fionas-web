// The two confirmations nats-purge.mjs needs before it deletes every event in the stream.
// Pure apart from the injected `ask`, so it is unit-tested.

/**
 * Asks twice: a yes/no that states how much will be lost, then the stream's name typed out.
 * Resolves true only if both are answered correctly; anything else (including Enter) is a no.
 */
export async function confirmPurge({ stream, messages, ask, write = console.log }) {
	write(`This permanently deletes all ${messages} event(s) from ${stream}. It cannot be undone.`);
	const first = (await ask(`Delete ${messages} event(s) from ${stream}? [y/N]: `)).trim();
	if (!/^y(es)?$/i.test(first)) return false;
	const second = (await ask(`Final check: type ${stream} to confirm: `)).trim();
	return second === stream;
}
