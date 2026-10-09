import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NATS_URL } from './nats.js';

/**
 * Brings up the local NATS + JetStream (compose.yaml) and creates or verifies the inquiry stream,
 * so the booking preview publishes to a real stream. With E2E_NATS_URL set, uses that server as
 * it is (no Docker). Records the start time, so the tests only read this run's events.
 */
export default function globalSetup() {
	const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
	// A minute early: the NATS server's clock (in a Docker VM) may lag this one.
	process.env.E2E_NATS_SINCE = new Date(Date.now() - 60_000).toISOString();
	const run = (command: string, args: string[]) =>
		execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
	if (!process.env.E2E_NATS_URL) {
		try {
			run('docker', ['compose', 'up', '--detach', '--wait', 'nats']);
		} catch (e) {
			throw new Error(
				'The booking e2e tests need NATS: start Docker, or set E2E_NATS_URL to a running server.',
				{ cause: e }
			);
		}
	}
	run(process.execPath, ['scripts/nats-setup.mjs', '--server', NATS_URL]);
}
