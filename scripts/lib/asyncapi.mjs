// Parses and validates the AsyncAPI document with the official parser, then checks every message
// example against its own payload and headers schemas (which the parser does not). Shared by
// validate-asyncapi.mjs and the tests.

import { readFile } from 'node:fs/promises';
import { DiagnosticSeverity, Parser } from '@asyncapi/parser';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';

/** An Ajv validator for a schema the parser resolved (its `x-parser-*` annotations ignored). */
export function compileSchema(schema) {
	const ajv = new Ajv({ strict: false, allErrors: true });
	addFormats.default(ajv);
	return ajv.compile(schema);
}

/** Every message example that doesn't match its schemas, as diagnostics. */
function exampleProblems(document) {
	const problems = [];
	for (const message of document.allMessages()) {
		const payload = message.payload() && compileSchema(message.payload().json());
		const headers = message.headers() && compileSchema(message.headers().json());
		for (const [index, example] of message.examples().all().entries()) {
			for (const [part, validate, value] of [
				['payload', payload, example.payload()],
				['headers', headers, example.headers()]
			]) {
				if (!validate || value === undefined || validate(value)) continue;
				for (const e of validate.errors)
					problems.push({
						path: [
							'messages',
							message.id(),
							'examples',
							index,
							part,
							...e.instancePath.split('/').slice(1)
						],
						message: e.message,
						code: 'example-schema'
					});
			}
		}
	}
	return problems;
}

/** Parses `file`; `errors` holds every error-severity diagnostic (empty when valid). */
export async function validateAsyncApi(file) {
	const source = await readFile(file, 'utf8');
	const { document, diagnostics } = await new Parser().parse(source, { source: file });
	return {
		document,
		errors: [
			...diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error),
			...(document ? exampleProblems(document) : [])
		],
		warnings: diagnostics.filter((d) => d.severity === DiagnosticSeverity.Warning)
	};
}

export const formatDiagnostics = (diagnostics) =>
	diagnostics.map((d) => `  ${d.path.join('.') || '(root)'}: ${d.message} [${d.code}]`).join('\n');
