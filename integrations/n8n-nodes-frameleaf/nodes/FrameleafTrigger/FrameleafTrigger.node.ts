import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	IPollFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { ConnectClient, SafeMessageError, validateConnection } from '../Frameleaf/client';
import { pollFeed } from './poll';
import { boundRequest } from '../../credentials/request';

export class FrameleafTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Frameleaf Trigger',
		name: 'frameleafTrigger',
		icon: { light: 'file:../Frameleaf/frameleaf.svg', dark: 'file:../Frameleaf/frameleaf.svg' },
		subtitle: '={{$parameter["event"]}}',
		group: ['trigger'],
		version: 1,
		description: 'Watch authorized Frameleaf media events',
		defaults: { name: 'Frameleaf Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		polling: true,
		credentials: [{ name: 'frameleafOAuth2Api', required: true }],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				default: 'asset.ready',
				options: [
					{ name: 'Album Asset Added', value: 'album.asset.added' },
					{ name: 'Asset Ready', value: 'asset.ready' },
					{ name: 'Studio Export Completed', value: 'studio.export.completed' },
				],
			},
			{
				displayName: 'Album ID',
				name: 'albumId',
				type: 'string',
				default: '',
				description: 'Optional album filter, limited to the albums selected during consent',
			},
			{
				displayName: 'Checkpoint Label',
				name: 'checkpoint',
				type: 'string',
				default: 'initial',
				required: true,
				description:
					'Changing this label explicitly starts a new checkpoint from now. Use a new label after changing filters or receiving an expired-cursor error. Older events are not replayed.',
			},
			{
				displayName:
					'Activation starts from now. Events remain available for 30 days. Test polling uses a sample and never changes the live checkpoint. Repeated deliveries retain their deliveryId; use it as a Source ID for idempotent writes.',
				name: 'pollNotice',
				type: 'notice',
				default: '',
			},
		],
	};
	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		try {
			const base = validateConnection(await this.getCredentials('frameleafOAuth2Api'));
			const client = new ConnectClient(base, (options) => boundRequest(this, base, options));
			const events = await pollFeed(
				client,
				this.getWorkflowStaticData('node'),
				{
					type: String(this.getNodeParameter('event')),
					albumId: String(this.getNodeParameter('albumId', '')),
					checkpoint: String(this.getNodeParameter('checkpoint')),
				},
				this.getMode() === 'manual',
				this.getPollBudgetMs(),
			);
			return events.length ? [events.map((json) => ({ json }))] : null;
		} catch (error) {
			throw new NodeOperationError(
				this.getNode(),
				error instanceof SafeMessageError
					? error.message
					: 'Frameleaf polling failed. Check the connection.',
			);
		}
	}
}
