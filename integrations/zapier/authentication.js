const locales = require('./locales.json');
const createConnect = require('./connect');
module.exports = function createAuthentication(locale = 'en') {
  const text = locales[locale];
  if (!Object.hasOwn(locales, locale)) throw new Error('Unsupported locale');
  const { SCOPES, sameScopes, configuration, callback, request } =
    createConnect(text);
  const scope = SCOPES.join(' ');

  function credential(data, config, previous) {
    const valid = (value) =>
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 8192 &&
      !/[\r\n]/.test(value);
    if (
      !valid(data.access_token) ||
      !valid(data.refresh_token) ||
      data.refresh_token === previous ||
      data.token_type?.toLowerCase() !== 'bearer' ||
      !Number.isSafeInteger(data.expires_in) ||
      data.expires_in < 1 ||
      data.expires_in > 86400 ||
      !sameScopes(data.scope)
    )
      throw new Error(text.reconnect);
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_type: 'Bearer',
      expires_in: data.expires_in,
      scope,
      serverUrl: config.origin,
      frameleafClientId: config.client,
      frameleafResource: config.resource,
      frameleafBoundClientId: config.client,
    };
  }
  async function token(z, config, body, previous) {
    const data = await request(
      z,
      {
        url: config.origin + '/api/oauth/apps/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...body,
          client_id: config.client,
          resource: config.resource,
        }).toString(),
      },
      true,
    );
    return credential(data, config, previous);
  }
  const authentication = {
    type: 'oauth2',
    fields: [
      {
        key: 'serverUrl',
        type: 'string',
        required: true,
        label: text.serverLabel,
        helpText: text.serverHelp,
      },
      {
        key: 'frameleafClientId',
        type: 'string',
        required: true,
        label: text.clientLabel,
        helpText: text.clientHelp,
      },
      {
        key: 'frameleafResource',
        type: 'string',
        required: true,
        computed: true,
      },
      {
        key: 'frameleafBoundClientId',
        type: 'string',
        required: true,
        computed: true,
      },
    ],
    connectionLabel: '{{serverUrl}}',
    oauth2Config: {
      enablePkce: true,
      autoRefresh: true,
      scope,
      authorizeUrl: async (z, bundle) => {
        const config = configuration(bundle);
        if (
          typeof bundle.inputData?.state !== 'string' ||
          !bundle.inputData.state
        )
          throw new Error(text.invalidCallback);
        const params = new URLSearchParams({
          client_id: config.client,
          redirect_uri: callback(bundle.inputData.redirect_uri),
          state: bundle.inputData.state,
          response_type: 'code',
          resource: config.resource,
          scope,
        });
        return config.origin + '/api/oauth/apps/authorize?' + params;
      },
      getAccessToken: async (z, bundle) => {
        const config = configuration(bundle);
        const input = bundle.inputData;
        if (
          typeof input?.code !== 'string' ||
          !input.code ||
          !/^[a-zA-Z0-9._~-]{43,128}$/.test(input.code_verifier ?? '')
        )
          throw new Error(text.reconnect);
        return token(z, config, {
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: callback(input.redirect_uri),
          code_verifier: input.code_verifier,
        });
      },
      refreshAccessToken: async (z, bundle) => {
        const config = configuration(bundle, true);
        const previous = bundle.authData.refresh_token;
        if (typeof previous !== 'string' || !previous || previous.length > 8192)
          throw new Error(text.reconnect);
        return token(
          z,
          config,
          { grant_type: 'refresh_token', refresh_token: previous },
          previous,
        );
      },
    },
    test: async (z, bundle) => {
      const config = configuration(bundle, true);
      const access = bundle.authData.access_token;
      if (
        typeof access !== 'string' ||
        !access ||
        access.length > 8192 ||
        /[\r\n]/.test(access)
      )
        throw new Error(text.reconnect);
      const data = await request(z, {
        url: config.resource + '/capabilities',
        method: 'GET',
        headers: { Authorization: 'Bearer ' + access },
      });
      if (
        data.protocolVersion !== 1 ||
        !Array.isArray(data.scopes) ||
        !sameScopes(data.scopes.join(' ')) ||
        !data.server?.id ||
        !data.connection?.grantId
      )
        throw new Error(text.reconnect);
      return { serverUrl: config.origin };
    },
  };
  return authentication;
};
