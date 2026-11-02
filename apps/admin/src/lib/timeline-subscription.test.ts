import { afterEach, expect, it, vi } from 'vitest';
import { timelineSubscription } from './timeline-subscription.js';
import { mayaId } from '../../e2e/request-fixture.mjs';

class Source extends EventTarget {
	readyState = 1;
	close = vi.fn(() => {
		this.readyState = 2;
	});
	hint(data = JSON.stringify({ inquiryId: mayaId, revision: '0' })) {
		this.dispatchEvent(new MessageEvent('timeline.changed', { data }));
	}
}
function setup() {
	const sources: Source[] = [];
	const create = vi.fn(() => {
		const source = new Source();
		sources.push(source);
		return source;
	});
	const invalidate = vi.fn().mockResolvedValue(true);
	const state = vi.fn();
	const controller = timelineSubscription({ inquiryId: mayaId, create, invalidate, state });
	return { sources, create, invalidate, state, controller };
}
afterEach(() => vi.useRealTimers());
it('owns one source, synchronizes revision zero and repeats it after reconnect, never on open', async () => {
	const t = setup();
	t.controller.resume();
	t.controller.resume();
	expect(t.create).toHaveBeenCalledExactlyOnceWith(`/requests/${mayaId}/updates`);
	t.sources[0].dispatchEvent(new Event('open'));
	t.sources[0].dispatchEvent(new MessageEvent('message', { data: ': heartbeat' }));
	expect(t.invalidate).not.toHaveBeenCalled();
	t.sources[0].hint();
	await Promise.resolve();
	expect(t.state).toHaveBeenLastCalledWith('Live');
	t.sources[0].readyState = 0;
	t.sources[0].dispatchEvent(new Event('error'));
	t.sources[0].hint();
	await Promise.resolve();
	expect(t.invalidate).toHaveBeenCalledTimes(2);
	t.controller.pause();
	t.controller.resume();
	t.sources[1].hint();
	await Promise.resolve();
	expect(t.invalidate).toHaveBeenCalledTimes(3);
	t.controller.dispose();
	t.controller.resume();
	expect(t.create).toHaveBeenCalledTimes(2);
	expect(t.sources.every((s) => s.close.mock.calls.length === 1)).toBe(true);
});
it('ignores bounded malformed/unrelated events and stops terminal failures', () => {
	const t = setup();
	t.controller.resume();
	for (const data of [
		'{',
		'null',
		'x'.repeat(513),
		JSON.stringify({ inquiryId: 'wrong', revision: '0' }),
		JSON.stringify({ inquiryId: mayaId, revision: 0 })
	])
		t.sources[0].hint(data);
	expect(t.invalidate).not.toHaveBeenCalled();
	t.sources[0].readyState = 2;
	t.sources[0].dispatchEvent(new Event('error'));
	t.controller.resume();
	expect(t.create).toHaveBeenCalledTimes(1);
	expect(t.state).toHaveBeenLastCalledWith('Updates paused');
	t.controller.dispose();
});
it('pauses prolonged unsynchronized connections without competing reconnect timers', async () => {
	vi.useFakeTimers();
	const t = setup();
	t.controller.resume();
	await vi.advanceTimersByTimeAsync(120000);
	expect(t.sources[0].close).toHaveBeenCalledOnce();
	expect(t.create).toHaveBeenCalledOnce();
	expect(t.state).toHaveBeenLastCalledWith('Updates paused');
	t.controller.dispose();
	expect(vi.getTimerCount()).toBe(0);
});
it('does not connect during SSR', () => {
	const controller = timelineSubscription({
		inquiryId: mayaId,
		invalidate: vi.fn(),
		state: vi.fn()
	});
	controller.resume();
	controller.dispose();
});
