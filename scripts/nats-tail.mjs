// Prints the events in the FIONAS_INQUIRIES stream as they arrive, for local debugging.
// Read-only: an ordered (ephemeral) consumer, so nothing is acknowledged or left behind.
//
//   npm run nats:tail [-- --all] [-- --subject fionas.inquiries.submitted.v1]
//
// In a terminal it asks for the NATS URL (Enter = local Docker) and a hidden token, or failing
// that a .creds file or username/password. Flags/env skip the prompts.

import { DeliverPolicy, jetstream } from '@nats-io/jetstream';
import { promptSetupConnection } from './lib/nats-setup-prompt.mjs';
import {
	CONNECTION_OPTIONS,
	CONNECTION_USAGE,
	connectOrExit,
	parseCommandLine
} from './lib/nats-connect.mjs';
import { STREAM, SUBJECTS } from './lib/nats-stream.mjs';

const USAGE = `Usage: npm run nats:tail -- [options]

Prints events from ${STREAM} as they are published (Ctrl+C to stop).
In a terminal, prompts for a missing target (default local Docker), then a hidden token, or a
.creds file / username and password. Provided flags/environment credentials skip the credential
prompts. Without a terminal, uses flags/env.

  --non-interactive   skip prompts (for automation)
  --all             start from the first stored event instead of new ones
  --subject <subj>    only this subject (default ${SUBJECTS.join(', ')})

${CONNECTION_USAGE}

  -h, --help`;

const values = parseCommandLine(
	{
		...CONNECTION_OPTIONS,
		'non-interactive': { type: 'boolean', default: false },
		all: { type: 'boolean', default: false },
		subject: { type: 'string' }
	},
	USAGE
);

let connectionValues;
try {
	connectionValues = await promptSetupConnection(values, { otherAuth: true });
} catch {
	console.error('Cancelled.');
	process.exit(1);
}
const nc = await connectOrExit('fionas-nats-tail', connectionValues);
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
