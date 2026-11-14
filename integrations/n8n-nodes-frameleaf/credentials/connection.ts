import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

export const PERMISSION_PROFILES = [
	{ name: 'Read Media', value: 'library:read' },
	{ name: 'Read Media and Originals', value: 'library:read library:download' },
	{ name: 'Organize Media', value: 'library:read albums:write tags:write' },
	{ name: 'Upload Photos', value: 'photos:upload' },
	{ name: 'Upload to Boards', value: 'boards:upload' },
	{
		name: 'Automate Photos',
		value: 'library:read albums:write tags:write photos:upload',
	},
	{
		name: 'Automate Boards',
		value: 'library:read albums:write tags:write boards:upload',
	},
];

export class SafeMessageError extends Error {}
export function fail(message: string): never {
	throw new SafeMessageError(message);
}

export function origin(value: string): string {
	if (!URL.canParse(value)) throw new SafeMessageError('Enter a valid Library URL.');
	const parsed = new URL(value);
	if (
		!['http:', 'https:'].includes(parsed.protocol) ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		parsed.pathname !== '/'
	)
		throw new SafeMessageError(
			'Enter the Library origin without a path, query, username, or password.',
		);
	return parsed.origin;
}
export function validateConnection(credentials: ICredentialDataDecryptedObject): string {
	const base = origin(String(credentials.libraryUrl));
	const profile = PERMISSION_PROFILES.find((p) => p.value === credentials.permissionProfile);
	const token = credentials.oauthTokenData as { scope?: string; resource?: string } | undefined;
	if (
		!profile ||
		token?.resource !== `${base}/api/connect` ||
		!token?.scope ||
		token.scope.split(' ').some((scope) => !profile.value.split(' ').includes(scope))
	)
		throw new SafeMessageError('Reconnect Frameleaf with the selected permission profile.');
	if (credentials.useDynamicClientRegistration === true || credentials.ignoreSSLIssues === true)
		throw new SafeMessageError(
			'Reconnect using an administrator-provisioned client ID and trusted TLS.',
		);
	return base;
}
