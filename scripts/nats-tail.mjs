// Prints the events in the FIONAS_INQUIRIES stream as they arrive, for local debugging.
// Read-only: an ordered (ephemeral) consumer, so nothing is acknowledged or left behind.
//
//   npm run nats:tail [-- --all] [-- --subject fionas.inquiries.submitted.v1]

import { DeliverPolicy, jetstream } from '@nats-io/jetstream';
import {
	CONNECTION_OPTIONS,
	CONNECTION_USAGE,
	connectOrExit,
	parseCommandLine
} from './lib/nats-connect.mjs';
import { STREAM, SUBJECTS } from './lib/nats-stream.mjs';

const USAGE = `Usage: npm run nats:tail -- [options]

Prints events from ${STREAM} as they are published (Ctrl+C to stop).

  --all               start from the first stored event instead of new ones
  --subject <subj>    only this subject (default ${SUBJECTS.join(', ')})

${CONNECTION_USAGE}

  -h, --help`;

const values = parseCommandLine(
	{
		...CONNECTION_OPTIONS,
		all: { type: 'boolean', default: false },
		subject: { type: 'string' }
	},
	USAGE
);

const nc = await connectOrExit('fionas-nats-tail', values);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => nc.close());

const consumer = await jetstream(nc).consumers.get(STREAM, {
	filter_subjects: values.subject ? [values.subject] : SUBJECTS,
	deliver_policy: values.all ? DeliverPolicy.All : DeliverPolicy.New
});
console.error(`Watching ${STREAM} for ${values.all ? 'all' : 'new'} events (Ctrl+C to stop)`);

const messages = await consumer.consume();
nc.closed().then(() => messages.stop());
for await (const m of messages) {
	const headers = Object.fromEntries((m.headers?.keys() ?? []).map((k) => [k, m.headers.get(k)]));
	let payload;
	try {
		payload = m.json();
	} catch {
		payload = m.string();
	}
	console.log(`\n#${m.seq} ${m.subject} ${new Date(m.info.timestampNanos / 1e6).toISOString()}`);
	console.log(JSON.stringify({ headers, payload }, null, 2));
}
