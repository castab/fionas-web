// Validates the repository's AsyncAPI document (../asyncapi.yaml): the versioned contract for the
// events the websites publish to NATS. Exits 1 on any error-severity diagnostic.
//
//   npm run asyncapi:validate [-- path/to/asyncapi.yaml]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDiagnostics, validateAsyncApi } from './lib/asyncapi.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.resolve(process.argv[2] ?? path.join(repoRoot, 'asyncapi.yaml'));

const { document, errors, warnings } = await validateAsyncApi(file);
if (warnings.length) console.warn(formatDiagnostics(warnings));
if (errors.length || !document) {
	console.error(formatDiagnostics(errors));
	console.error(`✗ ${path.relative(process.cwd(), file)} is not a valid AsyncAPI document`);
	process.exit(1);
}
console.log(
	`✓ ${path.relative(process.cwd(), file)}: AsyncAPI ${document.version()}, ${document.info().title()} ${document.info().version()}`
);
