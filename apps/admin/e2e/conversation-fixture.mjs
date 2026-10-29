import { proposalPair, requestFixtures, mayaId } from './request-fixture.mjs';
import { revisionFixture } from './revision-fixture.mjs';

export const customerMessageId = '71000000-0000-0000-0000-000000000001';
/** @type {import('../src/lib/conversation-contract.js').TimelineActor} */
export const actor = { principalKind: 'USER', principalId: '00000000-0000-0000-0000-000000000001' };
/** @returns {import('../src/lib/conversation-contract.js').StaffTimeline} */
export function conversationFixture() {
	const request = requestFixtures()[mayaId];
	const financial = { ...structuredClone(request.financial), version: 2, stage: 'QUOTE' };
	const pair = proposalPair(
		mayaId,
		financial.id,
		2,
		financial.total,
		request.suggestedDepositTerms,
		'USD'
	);
	if (!pair.proposal || pair.depositRequirement.state !== 'ACTIVE')
		throw new Error('Invalid quote fixture');
	const { satisfied, ...depositRequirement } = pair.depositRequirement;
	void satisfied;
	return {
		conversation: {
			state: 'READY',
			subject: 'Your Fiona’s Ice Cream booking',
			providerState: 'awaiting_us',
			latestMessageId: customerMessageId
		},
		attention: {
			needsReply: true,
			throughRecordedOrder: 12,
			unacknowledgedSince: '2026-10-28T20:00:00Z',
			latestEmailAt: '2026-10-28T20:00:00Z'
		},
		items: [
			{
				kind: 'QUOTE_PUBLISHED',
				id: 'quote:1',
				occurredAt: pair.proposal.issuedAt,
				proposal: pair.proposal,
				financial,
				depositRequirement,
				actor
			},
			{
				kind: 'MESSAGE',
				id: `message:${customerMessageId}`,
				messageId: customerMessageId,
				occurredAt: '2026-10-28T20:00:00Z',
				direction: 'inbound',
				senderAddress: request.inquiry.email,
				senderName: request.inquiry.name,
				recipient: 'bookings@fionas.example',
				text: 'Hi Fiona’s!\nCould we move the setup to the garden?\n\nThank you,\nMaya',
				sendState: 'received'
			}
		]
	};
}

/** All commerce bands, with exact versions and amounts supplied by the fixture backend.
 * @returns {import('../src/lib/conversation-contract.js').StaffTimeline} */
export function milestoneFixture() {
	const timeline = conversationFixture();
	const financial = revisionFixture('invoice-financial-amendment').financial;
	const occurredAt = '2026-10-28T21:00:00Z';
	const allocation = {
		documentId: financial.id,
		documentVersion: 2,
		amount: '83.00',
		currency: 'USD',
		allocatedAt: occurredAt
	};
	timeline.items.push(
		{ kind: 'INVOICE_AMENDED', id: 'invoice:4', occurredAt, financial },
		{
			kind: 'PAYMENT_RECORDED',
			id: 'payment:deposit',
			occurredAt,
			paymentId: 'deposit-receipt',
			amount: '83.00',
			currency: 'USD',
			method: 'CHECK',
			classification: 'DEPOSIT',
			proposalId: 'deposit-proposal',
			depositRequirementRevision: 1,
			allocations: [
				{
					...allocation,
					allocationId: 'deposit-allocation',
					canonical: true,
					documentStage: 'QUOTE'
				}
			]
		},
		{
			kind: 'PAYMENT_RECORDED',
			id: 'payment:additional',
			occurredAt,
			paymentId: 'additional-receipt',
			amount: '50.00',
			currency: 'USD',
			method: 'CASH',
			classification: 'ADDITIONAL',
			allocations: [
				{
					...allocation,
					amount: '50.00',
					documentVersion: 3,
					allocationId: 'additional-allocation',
					canonical: true,
					documentStage: 'INVOICE'
				}
			]
		},
		{
			kind: 'REFUND_RECORDED',
			id: 'refund:1',
			occurredAt,
			refundId: 'refund',
			paymentId: 'additional-receipt',
			amount: '10.00',
			currency: 'USD',
			method: 'CASH',
			paymentClassification: 'ADDITIONAL',
			unwound: [
				{
					...allocation,
					amount: '10.00',
					documentVersion: 3,
					refundAllocationId: 'refund-allocation',
					paymentAllocationId: 'additional-allocation'
				}
			]
		},
		{ kind: 'COMMUNICATION_ACKNOWLEDGED', id: 'ack:1', occurredAt, actor },
		{ kind: 'SERVED', id: 'served:1', occurredAt, actor },
		{ kind: 'CLOSED', id: 'closed:1', occurredAt, actor },
		{ kind: 'DECLINED', id: 'declined:1', occurredAt, actor, reason: 'Internal fixture reason' }
	);
	return timeline;
}
