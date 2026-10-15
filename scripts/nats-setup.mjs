// Creates, or verifies, the JetStream stream the websites publish their events to
// (FIONAS_INQUIRIES; see lib/nats-stream.mjs and ../asyncapi.yaml).
//
// Safe to re-run: an existing stream that matches is left alone. One that differs is reported and
// left unchanged (exit 1) unless --update is given; it is never silently rewritten.
//
//   npm run nats:setup [-- options]

import { jetstreamManager } from '@nats-io/jetstream';
import { promptSetupConnection } from './lib/nats-setup-prompt.mjs';
import {
	CONNECTION_OPTIONS,
	CONNECTION_USAGE,
	connectOrExit,
	parseCommandLine
} from './lib/nats-connect.mjs';
import {
	IMMUTABLE,
	STREAM,
	desiredStreamConfig,
	diffStreamConfig,
	formatDuration,
	parseMaxAge,
	parseReplicas
} from './lib/nats-stream.mjs';

const USAGE = `Usage: npm run nats:setup -- [options]

Creates the ${STREAM} stream if it is missing, or verifies an existing one.
In a terminal, prompts for a missing target (default local Docker) and a hidden token.
Provided flags/environment credentials skip the token prompt. Without a terminal, uses flags/env.

  --non-interactive  skip prompts (for automation)

Stream
  --replicas <n>      replicas, 1 to 5                          default 1
  --max-age <age>     keep events for 90d, 12h, … or 0 (forever) default 0
  --update            apply differences to an existing stream (otherwise report them and exit 1)

${CONNECTION_USAGE}

  -h, --help`;

const values = parseCommandLine(
	{
		...CONNECTION_OPTIONS,
		'non-interactive': { type: 'boolean', default: false },
		replicas: { type: 'string' },
		'max-age': { type: 'string' },
		update: { type: 'boolean', default: false }
	},
	USAGE
);

let desired;
try {
	desired = desiredStreamConfig({
		replicas: parseReplicas(values.replicas),
		maxAge: parseMaxAge(values['max-age'])
	});
} catch (e) {
	console.error(e.message);
	process.exit(2);
}

const show = (key, value) =>
	key === 'max_age' || key === 'duplicate_window' ? formatDuration(value) : JSON.stringify(value);

let connectionValues;
try {
	connectionValues = await promptSetupConnection(values);
} catch {
	console.error('Setup cancelled. Nothing was changed.');
	process.exit(1);
}
const nc = await connectOrExit('fionas-nats-setup', connectionValues);
let exitCode = 0;
try {
	const jsm = await jetstreamManager(nc);
	const existing = await jsm.streams.info(STREAM).then(
		(info) => info.config,
		(e) => {
			if (e?.name === 'StreamNotFoundError') return null;
			throw e;
		}
	);

	if (!existing) {
		await jsm.streams.add(desired);
		console.log(`✓ Created stream ${STREAM}`);
	} else {
		const diff = diffStreamConfig(existing, desired);
		if (diff.length === 0) {
			console.log(`✓ Stream ${STREAM} exists and matches`);
		} else {
			console.log(`Stream ${STREAM} differs from the expected configuration:`);
			for (const d of diff)
				console.log(`  ${d.key}: ${show(d.key, d.existing)} → ${show(d.key, d.desired)}`);
			const fixed = diff.filter((d) => IMMUTABLE.has(d.key));
			if (fixed.length) {
				console.error(
					`✗ ${fixed.map((d) => d.key).join(', ')} can't change on an existing stream; migrate to a new stream deliberately. Nothing was changed.`
				);
				exitCode = 1;
			} else if (values.update) {
				await jsm.streams.update(STREAM, { ...existing, ...desired });
				console.log(`✓ Updated stream ${STREAM}`);
			} else {
				console.error('✗ Nothing was changed. Re-run with --update to apply these settings.');
				exitCode = 1;
			}
		}
	}
	const { config, state } = await jsm.streams.info(STREAM);
	console.log(
		`  subjects ${config.subjects.join(', ')} · ${state.messages} messages · duplicate window ${formatDuration(config.duplicate_window)} · max age ${formatDuration(config.max_age)} · replicas ${config.num_replicas}`
	);
} catch {
	console.error(
		'✗ Stream setup failed. Check JetStream availability and stream-management permissions.'
	);
	exitCode = 1;
} finally {
	await nc.close();
}
process.exit(exitCode);
