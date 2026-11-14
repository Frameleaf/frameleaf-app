import type {
	ICredentialType,
	INodeProperties,
	Icon,
	ICredentialDataDecryptedObject,
	IDataObject,
} from 'n8n-workflow';

import { PERMISSION_PROFILES, validateConnection } from './connection';

export class FrameleafOAuth2Api implements ICredentialType {
	name = 'frameleafOAuth2Api';
	displayName = 'Frameleaf OAuth2 API';
	extends = ['oAuth2Api'];
	icon: Icon = {
		light: 'file:../nodes/Frameleaf/frameleaf.svg',
		dark: 'file:../nodes/Frameleaf/frameleaf.svg',
	};
	documentationUrl =
		'https://github.com/Frameleaf/frameleaf-app/tree/main/integrations/n8n-nodes-frameleaf';
	supportedNodes = ['frameleaf'];
	restrictToSupportedNodes = true as const;
	properties: INodeProperties[] = [
		{
			displayName:
				'Use a regular, single-process self-hosted n8n installation. Queue mode, multiple workers, and n8n Cloud are not supported. Ask your Library administrator to register the exact OAuth Redirect URL shown above as a public PKCE client. The callback must use trusted HTTPS.',
			name: 'setupNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Library URL',
			name: 'libraryUrl',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://photos.example.com',
			description: 'Canonical Library origin, without a path, query, username, or password',
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'string',
			default: '',
			required: true,
			description: 'Non-secret client ID supplied by your Library administrator',
		},
		{
			displayName: 'Permissions',
			name: 'permissionProfile',
			type: 'options',
			default: 'library:read',
			options: PERMISSION_PROFILES,
			description:
				'Choose the smallest profile your workflow needs. Reconnect after changing this setting; select readable albums and writable destinations during consent.',
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'hidden',
			typeOptions: { password: true },
			default: '',
			required: false,
		},
		{ displayName: 'Grant Type', name: 'grantType', type: 'hidden', default: 'pkce' },
		{ displayName: 'Authentication', name: 'authentication', type: 'hidden', default: 'body' },
		{
			displayName: 'Automatic Registration',
			name: 'useDynamicClientRegistration',
			type: 'hidden',
			default: false,
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: '={{ $self.libraryUrl.replace(/\\/$/, "") + "/api/oauth/apps/authorize" }}',
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: '={{ $self.libraryUrl.replace(/\\/$/, "") + "/api/oauth/apps/token" }}',
		},
		{
			displayName: 'Resource URL',
			name: 'resourceUrl',
			type: 'hidden',
			default: '={{ $self.libraryUrl.replace(/\\/$/, "") + "/api/connect" }}',
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: '={{ $self.permissionProfile }}',
		},
		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			default: '',
		},
		{ displayName: 'Ignore SSL Issues', name: 'ignoreSSLIssues', type: 'hidden', default: false },
	];
	async preAuthentication(credentials: ICredentialDataDecryptedObject): Promise<IDataObject> {
		validateConnection(credentials);
		return {};
	}
}
