import { connect } from '@nats-io/transport-node';
import { DeliverPolicy, jetstream } from '@nats-io/jetstream';
import type { InquirySubmittedEvent } from '../src/lib/server/inquiry-event.js';

/*
 * The e2e tests publish through a real NATS + JetStream (compose.yaml at the repository root,
 * started by global-setup.ts) and read back what /book published. Dev-only users and passwords
 * from infra/nats/nats-server.conf.
 */

/** Set E2E_NATS_URL to use an already running server (with the stream set up) instead of Docker. */
export const NATS_URL = process.env.E2E_NATS_URL ?? 'nats://127.0.0.1:4222';
/** What the booking preview publishes as: the least-privileged web user. */
export const WEB_USER = { NATS_USER: 'fionas-web', NATS_PASSWORD: 'fionas-web-dev' };
const ADMIN = { user: 'fionas-admin', pass: 'fionas-admin-dev' };
const STREAM = 'FIONAS_INQUIRIES';

export type PublishedInquiry = { msgID: string | undefined; event: InquirySubmittedEvent };

/** Events published since the e2e run started (global-setup.ts records when). */
export async function publishedInquiries(): Promise<PublishedInquiry[]> {
	const since = process.env.E2E_NATS_SINCE ?? new Date(0).toISOString();
	const nc = await connect({ servers: NATS_URL, ...ADMIN, name: 'fionas-e2e' });
	try {
		const consumer = await jetstream(nc).consumers.get(STREAM, {
			deliver_policy: DeliverPolicy.StartTime,
			opt_start_time: since
		});
		const found: PublishedInquiry[] = [];
		let pending = (await consumer.info(true)).num_pending;
		while (pending > 0) {
			const batch = await consumer.fetch({ max_messages: Math.min(pending, 256), expires: 2000 });
			let received = 0;
			for await (const m of batch) {
				received++;
				found.push({
					msgID: m.headers?.get('Nats-Msg-Id'),
					event: m.json<InquirySubmittedEvent>()
				});
				pending = m.info.pending;
			}
			if (received === 0) break;
		}
		return found;
	} finally {
		await nc.close();
	}
}

/** What /book published for this email, oldest first. */
export async function publishedFor(email: string): Promise<PublishedInquiry[]> {
	return (await publishedInquiries()).filter((p) => p.event.data.email === email);
}
