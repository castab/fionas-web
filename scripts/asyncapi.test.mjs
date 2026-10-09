import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateAsyncApi } from './lib/asyncapi.mjs';
import { INQUIRY_SUBMITTED_SUBJECT, STREAM, SUBJECTS } from './lib/nats-stream.mjs';

const file = fileURLToPath(new URL('../asyncapi.yaml', import.meta.url));
const { document, errors } = await validateAsyncApi(file);

describe('asyncapi.yaml', () => {
	it('is a valid AsyncAPI 3.1.0 document whose examples match their schemas', () => {
		expect(errors).toEqual([]);
		expect(document.version()).toBe('3.1.0');
	});

	it('describes the subject and stream the scripts set up', () => {
		const channel = document.channels().get('inquirySubmittedV1');
		expect(channel.address()).toBe(INQUIRY_SUBMITTED_SUBJECT);
		const prefix = SUBJECTS[0].replace(/>$/, '');
		expect(channel.address().startsWith(prefix)).toBe(true);
		expect(document.info().description()).toContain(STREAM);
	});

	it('versions the subject and the payload together', () => {
		const major = document.info().version().split('.')[0];
		expect(INQUIRY_SUBMITTED_SUBJECT.endsWith(`.v${major}`)).toBe(true);
		const payload = document.components().messages().get('InquirySubmittedV1').payload().json();
		expect(payload.properties.schemaVersion.const).toBe(Number(major));
	});

	it('only sends messages: the websites publish, others consume', () => {
		expect(
			document
				.operations()
				.all()
				.map((o) => o.action())
		).toEqual(['send']);
	});
});
