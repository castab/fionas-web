// Deletes every event in the FIONAS_INQUIRIES stream, keeping the stream and its configuration.
// Meant for resetting development data, and for the rare production clean-up.
//
// Destructive and irreversible, so it only runs in a terminal and asks twice (yes/no, then the
// stream's name typed out). There is deliberately no flag to skip the questions.
//
//   npm run nats:purge

import { jetstreamManager } from '@nats-io/jetstream';
import { askTerminal, promptSetupConnection } from './lib/nats-setup-prompt.mjs';
import { confirmPurge } from './lib/nats-purge-confirm.mjs';
import {
	CONNECTION_OPTIONS,
	CONNECTION_USAGE,
	connectOrExit,
	parseCommandLine
} from './lib/nats-connect.mjs';
import { STREAM } from './lib/nats-stream.mjs';

const USAGE = `Usage: npm run nats:purge -- [options]

Deletes ALL events from ${STREAM}; the stream itself and its settings are kept.
Requires a terminal. Prompts for a missing target (default local Docker) and credentials, then asks
twice before deleting anything. Provided flags/environment credentials skip the credential prompts.

${CONNECTION_USAGE}

  -h, --help`;

const values = parseCommandLine(CONNECTION_OPTIONS, USAGE);

if (!(process.stdin.isTTY && process.stdout.isTTY)) {
	console.error('✗ nats:purge needs an interactive terminal so it can ask for confirmation.');
	process.exit(1);
}

let connectionValues;
try {
	connectionValues = await promptSetupConnection(values, { otherAuth: true });
} catch {
	console.error('Cancelled. Nothing was deleted.');
	process.exit(1);
}
const nc = await connectOrExit('fionas-nats-purge', connectionValues);
let exitCode = 0;
try {
	const jsm = await jetstreamManager(nc);
	const { state } = await jsm.streams.info(STREAM);
	if (state.messages === 0) {
		console.log(`✓ ${STREAM} is already empty`);
	} else if (await confirmPurge({ stream: STREAM, messages: state.messages, ask: askTerminal })) {
		const { purged } = await jsm.streams.purge(STREAM);
		console.log(`✓ Deleted ${purged} event(s) from ${STREAM}`);
	} else {
		console.log('Cancelled. Nothing was deleted.');
		exitCode = 1;
	}
} catch (e) {
	if (e?.name === 'StreamNotFoundError') {
		console.error(`✗ Stream ${STREAM} doesn't exist. Run: npm run nats:setup`);
	} else if (/cancelled/i.test(e?.message ?? '')) {
		console.error('Cancelled. Nothing was deleted.');
	} else {
		console.error(
			'✗ Purge failed. Check JetStream availability and stream-management permissions. Nothing is known to be deleted.'
		);
	}
	exitCode = 1;
} finally {
	await nc.close();
}
process.exit(exitCode);
