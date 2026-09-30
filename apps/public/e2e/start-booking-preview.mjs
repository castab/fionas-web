// Starts a second preview of the same build with BOOKING_ENABLED=true. The gated server (which
// owns `npm run build`) must be up first, so wait for it before launching.
import { spawn } from 'node:child_process';

const [gatedUrl, port] = process.argv.slice(2);
const deadline = Date.now() + 180_000;

while (Date.now() < deadline) {
	try {
		await fetch(gatedUrl);
		break;
	} catch {
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

const child = spawn(`npm run preview -- --port ${port} --host 127.0.0.1`, {
	stdio: 'inherit',
	shell: true,
	env: { ...process.env, BOOKING_ENABLED: 'true' }
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
