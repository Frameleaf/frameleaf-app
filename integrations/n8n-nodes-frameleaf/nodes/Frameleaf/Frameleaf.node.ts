import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	IExecuteFunctions,
	IDataObject,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	ILoadOptionsFunctions,
} from 'n8n-workflow';
import {
	ConnectClient,
	fail,
	SafeMessageError,
	sourceRequestId,
	uuid,
	validateConnection,
} from './client';
import type { Album } from './client';
import { boundRequest } from '../../credentials/request';

const show = (...operation: string[]) => ({ show: { operation } });
const fields: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'listAlbums',
		options: [
			{ name: 'Add Assets to Album', value: 'addAssets', action: 'Add assets to an album' },
			{ name: 'Apply Tags', value: 'tag', action: 'Apply tags to an asset' },
			{ name: 'Cancel Upload', value: 'cancelUpload', action: 'Cancel an unpublished upload' },
			{ name: 'Create Album', value: 'createAlbum', action: 'Create an album' },
			{ name: 'Download Rendition', value: 'download', action: 'Download a media rendition' },
			{ name: 'Get Asset', value: 'getAsset', action: 'Get asset details' },
			{ name: 'Inspect Upload', value: 'inspectUpload', action: 'Inspect an upload' },
			{ name: 'List Albums', value: 'listAlbums', action: 'List authorized albums' },
			{ name: 'Search Media', value: 'search', action: 'Search media' },
			{ name: 'Upload Media', value: 'upload', action: 'Upload to photos or boards' },
		],
	},
	{
		displayName: 'Album Name or ID',
		name: 'albumId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getAlbums' },
		default: '',
		displayOptions: show('search', 'addAssets', 'upload'),
		description:
			'Choose from the list, or specify an ID using an expression. Read and write destinations follow the connection consent. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		default: '',
		displayOptions: show('search'),
	},
	{
		displayName: 'Media Type',
		name: 'mediaType',
		type: 'options',
		default: '',
		options: [
			{ name: 'All', value: '' },
			{ name: 'Image', value: 'IMAGE' },
			{ name: 'Video', value: 'VIDEO' },
		],
		displayOptions: show('search'),
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1, maxValue: 10000 },
		description: 'Max number of results to return',
		displayOptions: show('search'),
	},
	{
		displayName: 'Asset ID',
		name: 'assetId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: show('getAsset', 'download', 'tag'),
	},
	{
		displayName: 'Asset IDs',
		name: 'assetIds',
		type: 'string',
		default: '',
		required: true,
		description:
			'Comma-separated IDs, up to 100. Each asset must be readable and the album writable.',
		displayOptions: show('addAssets'),
	},
	{
		displayName: 'Tags',
		name: 'tags',
		type: 'string',
		default: '',
		required: true,
		description:
			'One tag per line, up to 20. The asset must be readable and in a writable destination.',
		typeOptions: { rows: 4 },
		displayOptions: show('tag'),
	},
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		default: '',
		required: true,
		displayOptions: show('createAlbum'),
	},
	{
		displayName: 'Workspace',
		name: 'workspace',
		type: 'options',
		default: 'photo',
		options: [
			{ name: 'Photos', value: 'photo' },
			{ name: 'Boards', value: 'design' },
		],
		displayOptions: show('createAlbum', 'upload'),
	},
	{
		displayName: 'Source ID',
		name: 'sourceId',
		type: 'string',
		default: '',
		required: true,
		description:
			'Map a stable source event or item ID. Keep it unchanged on retries; use a new source ID for a new saved result. Never use the execution ID or a random value.',
		displayOptions: show('createAlbum', 'upload'),
	},
	{
		displayName: 'Source Date',
		name: 'sourceDate',
		type: 'dateTime',
		default: '',
		required: true,
		description:
			'Map the source event date. Keep this value, filename, content, and destination unchanged when retrying.',
		displayOptions: show('upload'),
	},
	{
		displayName: 'Input Binary Field',
		name: 'inputBinaryField',
		type: 'string',
		default: 'data',
		required: true,
		description: 'The name of the input binary field containing the file to upload',
		displayOptions: show('upload'),
	},
	{
		displayName: 'Upload ID',
		name: 'uploadId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: show('inspectUpload', 'cancelUpload'),
	},
	{
		displayName: 'Rendition',
		name: 'variant',
		type: 'options',
		default: 'display',
		options: [
			{ name: 'Display JPEG', value: 'display' },
			{ name: 'Original (Requires Download Consent)', value: 'original' },
			{ name: 'Preview', value: 'preview' },
			{ name: 'Thumbnail', value: 'thumbnail' },
		],
		displayOptions: show('download'),
	},
	{
		displayName: 'Output Binary Field',
		name: 'binaryProperty',
		type: 'string',
		default: 'data',
		displayOptions: show('download'),
	},
	{
		displayName: 'Maximum Download Size (MiB)',
		name: 'maximumMiB',
		type: 'number',
		default: 32,
		typeOptions: { minValue: 1, maxValue: 512 },
		description: 'Stop the transfer if the response exceeds this limit',
		displayOptions: show('download'),
	},
];
export class Frameleaf implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Frameleaf',
		name: 'frameleaf',
		icon: { light: 'file:frameleaf.svg', dark: 'file:frameleaf.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Read and organize selected Frameleaf albums and upload media',
		defaults: { name: 'Frameleaf' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'frameleafOAuth2Api', required: true }],
		properties: fields,
	};
	methods = {
		loadOptions: {
			async getAlbums(this: ILoadOptionsFunctions) {
				const base = validateConnection(await this.getCredentials('frameleafOAuth2Api'));
				const client = new ConnectClient(base, (options) => boundRequest(this, base, options));
				const result = await client.json<{ items: Album[] }>('GET', '/albums');
				return [
					{ name: 'All Readable Albums (Search Only)', value: '' },
					...result.items.map((a) => ({
						name: `${a.name} (${a.workspace}${a.canWrite ? ', writable' : ''})`,
						value: a.id,
					})),
				];
			},
		},
	};
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const base = validateConnection(await this.getCredentials('frameleafOAuth2Api'));
		const client = new ConnectClient(
			base,
			(options) => boundRequest(this, base, options),
			this.getExecutionCancelSignal(),
		);
		const output: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				const param = (name: string, fallback = '') =>
					String(this.getNodeParameter(name, i, fallback));
				const operation = param('operation');
				let result: IDataObject | IDataObject[];
				if (operation === 'listAlbums')
					result = (await client.json<{ items: IDataObject[] }>('GET', '/albums')).items;
				else if (operation === 'getAsset')
					result = await client.json('GET', `/assets/${uuid(param('assetId'))}`);
				else if (operation === 'search') {
					const limit = Number(this.getNodeParameter('limit', i, 100));
					if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
						fail('Choose a search limit from 1 to 10000.');
					const query: IDataObject = { q: param('query') };
					if (param('albumId')) query.albumId = uuid(param('albumId'));
					if (param('mediaType')) query.type = param('mediaType');
					const found: IDataObject[] = [];
					for (let page = 1; found.length < limit; page++) {
						const response = await client.json<{ items: IDataObject[]; total: number }>(
							'GET',
							'/assets',
							undefined,
							{ ...query, page, size: 100 },
						);
						found.push(...response.items.slice(0, limit - found.length));
						if (response.items.length < 100 || page * 100 >= response.total) break;
					}
					result = found;
				} else if (operation === 'createAlbum')
					result = await client.json('POST', '/albums', {
						name: param('name'),
						workspace: param('workspace'),
						requestId: sourceRequestId(
							this.getWorkflow().id,
							this.getNode().id,
							operation,
							param('sourceId'),
						),
					});
				else if (operation === 'addAssets') {
					const assetIds = [
						...new Set(
							param('assetIds')
								.split(',')
								.map((x) => uuid(x.trim())),
						),
					];
					if (assetIds.length > 100) fail('Add at most 100 assets at once.');
					result = await client.json('POST', `/albums/${uuid(param('albumId'))}/assets`, {
						assetIds,
					});
				} else if (operation === 'tag') {
					const tags = [
						...new Set(
							param('tags')
								.split('\n')
								.map((x) => x.trim())
								.filter(Boolean),
						),
					];
					if (!tags.length || tags.length > 20) fail('Enter between 1 and 20 tags.');
					result = await client.json('POST', `/assets/${uuid(param('assetId'))}/tags`, { tags });
				} else if (operation === 'download') {
					const assetId = uuid(param('assetId'));
					const variant = param('variant', 'display');
					const response = await client.download(
						assetId,
						variant,
						Number(this.getNodeParameter('maximumMiB', i, 32)) * 1024 * 1024,
					);
					const mime =
						response.headers['content-type']?.split(';')[0] ?? 'application/octet-stream';
					const extension =
						(
							{
								'image/jpeg': 'jpg',
								'image/png': 'png',
								'image/webp': 'webp',
								'video/mp4': 'mp4',
								'application/pdf': 'pdf',
							} as Record<string, string>
						)[mime] ?? 'bin';
					output.push({
						json: { assetId, variant },
						binary: {
							[param('binaryProperty', 'data')]: await this.helpers.prepareBinaryData(
								response.body,
								`${assetId}-${variant}.${extension}`,
								mime,
							),
						},
						pairedItem: { item: i },
					});
					continue;
				} else if (operation === 'upload') {
					const field = param('inputBinaryField', 'data');
					const binary = this.helpers.assertBinaryData(i, field);
					const bytes = await this.helpers.getBinaryDataBuffer(i, field);
					const workspace = param('workspace');
					if (workspace !== 'photo' && workspace !== 'design') fail('Choose Photos or Boards.');
					result = {
						...(await client.upload(bytes, {
							requestId: sourceRequestId(
								this.getWorkflow().id,
								this.getNode().id,
								operation,
								param('sourceId'),
							),
							albumId: param('albumId'),
							workspace,
							filename: binary.fileName || 'upload',
							contentType: binary.mimeType,
							sourceDate: param('sourceDate'),
						})),
					};
				} else if (operation === 'inspectUpload' || operation === 'cancelUpload')
					result = await client.json(
						operation === 'inspectUpload' ? 'GET' : 'DELETE',
						`/uploads/${uuid(param('uploadId'))}`,
					);
				else fail('Choose a supported Frameleaf operation.');
				for (const json of Array.isArray(result) ? result : [result])
					output.push({ json, pairedItem: { item: i } });
			} catch (error) {
				const message =
					error instanceof SafeMessageError
						? error.message
						: 'Frameleaf operation failed. Check the connection and input, then retry.';
				if (this.continueOnFail())
					output.push({ json: { error: message }, pairedItem: { item: i } });
				else throw new NodeOperationError(this.getNode(), message, { itemIndex: i });
			}
		}
		return [output];
	}
}
