import type { IAllExecuteFunctions, IDataObject, IHttpRequestOptions } from 'n8n-workflow';
import { SafeMessageError, validateConnection } from './connection';

export async function boundRequest(
	context: IAllExecuteFunctions,
	base: string,
	options: IHttpRequestOptions,
): Promise<unknown> {
	const credentials = await context.getCredentials('frameleafOAuth2Api');
	if (validateConnection(credentials) !== base || new URL(options.url).origin !== base)
		throw new SafeMessageError('Reconnect Frameleaf before changing the request destination.');
	const send = (token: IDataObject) => {
		if (
			validateConnection({ ...credentials, oauthTokenData: token }) !== base ||
			typeof token.access_token !== 'string' ||
			!token.access_token ||
			/[\r\n]/.test(token.access_token)
		)
			throw new SafeMessageError('Reconnect Frameleaf with the selected Library.');
		return context.helpers.httpRequest({
			...options,
			headers: { ...options.headers, Authorization: `Bearer ${token.access_token}` },
		});
	};
	try {
		return await send(credentials.oauthTokenData as IDataObject);
	} catch (error) {
		// ConnectClient sanitizes transport errors before the node reports them.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		if ((error as { response?: { status?: number } })?.response?.status !== 401) throw error;
		// Native automatic retries can reuse a reconnected credential at the previous Library URL.
		const token = await context.helpers.refreshOAuth2Token.call(context, 'frameleafOAuth2Api');
		return await send(token as IDataObject);
	}
}
