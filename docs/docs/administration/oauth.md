# OAuth Authentication

This page contains details about using OAuth in Frameleaf.

:::tip
Unable to set `frameleaf-auth:///oauth-callback` as a valid redirect URI? See [Mobile Redirect URI](#mobile-redirect-uri) for an alternative solution.
:::

## Overview

Frameleaf supports 3rd party authentication via [OpenID Connect][oidc] (OIDC), an identity layer built on top of OAuth2. OIDC is supported by most identity providers, including:

- [Authentik](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)
- [Authelia](https://www.authelia.com/integration/openid-connect/introduction/)
- [Okta](https://www.okta.com/openid-connect/)
- [Google](https://developers.google.com/identity/openid-connect/openid-connect)
- [Keycloak](https://www.keycloak.org)

## Prerequisites

Before enabling OAuth in Frameleaf, a new client application needs to be configured in the 3rd-party authentication server. While the specifics of this setup vary from provider to provider, the general approach should be the same.

1. Create a new (Client) Application
   1. The **Provider** type should be `OpenID Connect` or `OAuth2`
   2. The **Client type** should be `Confidential`
   3. The **Application** type should be `Web`
   4. The **Grant** type should be `Authorization Code`

2. Configure Redirect URIs/Origins

   The **Sign-in redirect URIs** should include:
   - `frameleaf-auth:///oauth-callback` - for logging in with OAuth from the [Mobile App](/features/mobile-app.mdx)
   - `http://DOMAIN:PORT/auth/login` - for logging in with OAuth from the Web Client
   - `http://DOMAIN:PORT/user-settings` - for manually linking OAuth in the Web Client

   Redirect URIs should contain all the domains you will be using to access Frameleaf. Some examples include:

   Mobile
   - `frameleaf-auth:///oauth-callback` (You **MUST** include this for iOS and Android mobile apps to work properly)

   Localhost
   - `http://localhost:2283/auth/login`
   - `http://localhost:2283/user-settings`

   Local IP
   - `http://192.168.0.200:2283/auth/login`
   - `http://192.168.0.200:2283/user-settings`

   Hostname
   - `https://photos.example.com/auth/login`
   - `https://photos.example.com/user-settings`

3. Configure Backchannel logout URL

   If the authentication server supports it, the **Backchannel logout URL** can be specified, and it is of the form: `http://DOMAIN:PORT/api/oauth/backchannel-logout`.

## Verified email addresses

An email address from the provider is used to link a sign-in to an existing account, or to create a new account, only when the provider says it is verified: the `email_verified` claim must be `true` (the text `"true"` is accepted too). A sign-in with an unverified address, or without the claim, is refused with a message saying why.

:::note Upgrading
Some providers (for example Microsoft Entra ID) do not send `email_verified`. With them, a person whose account is not yet linked to the provider cannot sign in by email, and automatic registration is refused, until you map an `email_verified` claim in the provider. Accounts already linked to the provider (by its account ID) are not affected and keep signing in as before.
:::

## Refused and expired sign-ins

A sign-in only finishes in the browser (or app) that started it, within the provider's code lifetime. The server answers these callbacks with a `400` and a fixed message on the sign-in page, and nobody is signed in:

- the person declined at the provider, or the provider refused (`error=` in the callback): "The identity provider did not approve the sign-in";
- the callback's `state` (or `iss`) belongs to another sign-in: "This sign-in was started somewhere else or has expired";
- the code was already used, has expired or does not match the sign-in's PKCE verifier (`invalid_grant`): "This sign-in link has expired or was already used".

The provider's own error text is never shown, since anyone can put it in the address. The sign-in page offers the provider button again, and a `continue` address is only ever followed on this server. A callback that opens in another tab of the same browser (for example from an email link) still finishes, for 15 minutes.

The examples below use the custom claims `frameleaf_role` and `frameleaf_quota`. Set **Role Claim** and **Storage Quota Claim** to those names in Frameleaf and configure matching claims in the provider. An existing installation may use different names; keep both sides consistent.

## Enable OAuth

Once you have a new OAuth client application configured, Frameleaf can be configured using the Administration Settings page, available on the web (Administration -> Settings).

| Setting                                              | Type    | Example              | Description                                                                                                                                                 |
| ---------------------------------------------------- | ------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enabled                                              | boolean | false                | Enable/disable OAuth                                                                                                                                        |
| `issuer_url`                                         | URL     | (required)           | Required. Self-discovery URL for client (from previous step)                                                                                                |
| `client_id`                                          | string  | (required)           | Required. Client ID (from previous step)                                                                                                                    |
| `client_secret`                                      | string  | (required)           | Required. Client Secret (previous step)                                                                                                                     |
| `scope`                                              | string  | openid email profile | Full list of scopes to send with the request (space delimited)                                                                                              |
| `id_token_signed_response_alg`                       | string  | RS256                | The algorithm used to sign the id token (examples: RS256, HS256). Left empty, the algorithms the provider advertises in its discovery document are accepted |
| `userinfo_signed_response_alg`                       | string  | none                 | The algorithm used to sign the userinfo response (examples: RS256, HS256)                                                                                   |
| `prompt`                                             | string  | (empty)              | Prompt parameter for authorization url (examples: select_account, login, consent)                                                                           |
| `end_session_endpoint`                               | URL     | (empty)              | Http(s) alternative end session endpoint (logout URI)                                                                                                       |
| Request timeout                                      | string  | 30,000 (30 seconds)  | Number of milliseconds to wait for http requests to complete before giving up                                                                               |
| Storage Label Claim                                  | string  | preferred_username   | Claim mapping for the user's storage label**¹**                                                                                                             |
| Role Claim                                           | string  | frameleaf_role       | Claim mapping for the user's role. (should return "user" or "admin")**¹**                                                                                   |
| Storage Quota Claim                                  | string  | frameleaf_quota      | Claim mapping for the user's storage**¹**                                                                                                                   |
| Default Storage Quota (GiB)                          | number  | 0                    | Default quota for user without storage quota claim (empty for unlimited quota)                                                                              |
| Button Text                                          | string  | Login with OAuth     | Text for the OAuth button on the web                                                                                                                        |
| Auto Register                                        | boolean | true                 | When true, will automatically register a user the first time they sign in                                                                                   |
| [Auto Launch](#auto-launch)                          | boolean | false                | When true, will skip the login page and automatically start the OAuth login process                                                                         |
| [Mobile Redirect URI Override](#mobile-redirect-uri) | URL     | (empty)              | Http(s) alternative mobile redirect URI                                                                                                                     |

:::note Claim Options [1]

Claim is only used on user creation and not synchronized after that.

:::

:::info
The Issuer URL should look something like the following, and return a valid json document.

- `https://accounts.google.com/.well-known/openid-configuration`
- `http://localhost:9000/application/o/frameleaf/.well-known/openid-configuration`

The `.well-known/openid-configuration` part of the url is optional and will be automatically added during discovery.
:::

## Auto Launch

When Auto Launch is enabled, the login page will automatically redirect the user to the OAuth authorization url, to login with OAuth. To access the login screen again, use the browser's back button, or navigate directly to `/auth/login?autoLaunch=0`.
Auto Launch can also be enabled for a link by navigating to `/auth/login?autoLaunch=1`.

## Mobile Redirect URI

### Frameleaf mobile app

Register `frameleaf-auth:///oauth-callback` with your provider for a compatible Frameleaf app. If the provider does not accept custom schemes, use the server's mobile redirect override:

1. Set **Mobile Redirect URI Override** to this server's `/api/oauth/mobile-redirect` address, for example `https://photos.example.com/api/oauth/mobile-redirect`.
2. Register `https://photos.example.com/api/oauth/frameleaf-mobile-redirect` with the identity provider. The server selects that Frameleaf callback for the app and forwards it to `frameleaf-auth:///oauth-callback`.
3. Use the addresses displayed under **Mobile app callbacks** in the server's Authentication settings to verify your configuration. An arbitrary override address cannot be mapped safely and Frameleaf app sign-in is refused.

See [Frameleaf apps](/features/mobile-app) for availability and [Moving to Frameleaf](./frameleaf-app-transition.md) for import and sign-in guidance.

## Example Configuration

<details>
<summary>Authelia Example</summary>

### Authelia Example

Here's an example of OAuth configured for Authelia:

This assumes there exist an attribute `frameleafquota` in the user schema, which is used to set the user's storage quota in Frameleaf.
The configuration concerning the quota is optional.

```yaml
authentication_backend:
  ldap:
    # The LDAP server configuration goes here.
    # See: https://www.authelia.com/c/ldap
    attributes:
      extra:
        frameleafquota: # The attribute name from LDAP
          name: 'frameleaf_quota'
          multi_valued: false
          value_type: 'integer'
identity_providers:
  oidc:
    ## The other portions of the mandatory OpenID Connect 1.0 configuration go here.
    ## See: https://www.authelia.com/c/oidc
    claims_policies:
      frameleaf_policy:
        custom_claims:
          frameleaf_quota:
            attribute: 'frameleaf_quota'
    scopes:
      frameleaf_scope:
        claims:
          - 'frameleaf_quota'

    clients:
      - client_id: 'frameleaf'
        client_name: 'Frameleaf'
        # https://www.authelia.com/integration/openid-connect/frequently-asked-questions/#how-do-i-generate-a-client-identifier-or-client-secret
        client_secret: '$pbkdf2-sha512$310000$c8p78n7pUMln0jzvd4aK4Q$JNRBzwAo0ek5qKn50cFzzvE9RXV88h1wJn5KGiHrD0YKtZaR/nCb2CJPOsKaPK0hjf.9yHxzQGZziziccp6Yng'
        public: false
        require_pkce: true
        pkce_challenge_method: 'S256'
        redirect_uris:
          - 'https://photos.example.com/auth/login'
          - 'https://photos.example.com/user-settings'
          - 'frameleaf-auth:///oauth-callback'
        scopes:
          - 'openid'
          - 'profile'
          - 'email'
          - 'frameleaf_scope'
        claims_policy: 'frameleaf_policy'
        response_types:
          - 'code'
        grant_types:
          - 'authorization_code'
        id_token_signed_response_alg: 'RS256'
        userinfo_signed_response_alg: 'RS256'
        token_endpoint_auth_method: 'client_secret_post'
```

Configuration of OAuth in Frameleaf System Settings

| Setting                            | Value                                                               |
| ---------------------------------- | ------------------------------------------------------------------- |
| Issuer URL                         | `https://auth.example.com`                                          |
| Client ID                          | frameleaf                                                           |
| Client Secret                      | 0v89FXkQOWO\***\*\*\*\*\***\*\*\***\*\*\*\*\***mprbvXD549HH6s1iw... |
| Token Endpoint Auth Method         | client_secret_post                                                  |
| Scope                              | openid email profile frameleaf_scope                                |
| ID Token Signed Response Algorithm | RS256                                                               |
| Userinfo Signed Response Algorithm | RS256                                                               |
| End Session Endpoint               | https://auth.example.com/logout?rd=https://photos.example.com/      |
| Storage Label Claim                | uid                                                                 |
| Storage Quota Claim                | frameleaf_quota                                                     |
| Default Storage Quota (GiB)        | 0 (empty for unlimited quota)                                       |
| Button Text                        | Sign in with Authelia (optional)                                    |
| Auto Register                      | Enabled (optional)                                                  |
| Auto Launch                        | Enabled (optional)                                                  |
| Mobile Redirect URI Override       | Disable                                                             |
| Mobile Redirect URI                |                                                                     |

</details>

<details>
<summary>Authentik Example</summary>

### Authentik Example

Here's an example of OAuth configured for Authentik:

Configuration of Authorised redirect URIs (Authentik OAuth2/OpenID Provider)

1. Open the provider's **Protocol settings** and set **Client type** to **Confidential**.
2. In **Redirect URIs/Origins (RegEx)**, add one URI per line for each address you use, for example `https://photos.example.com/auth/login` and `https://photos.example.com/user-settings`, plus the mobile callback described in [Mobile Redirect URI](#mobile-redirect-uri).
3. Copy the **Client ID** and **Client Secret** into the Frameleaf settings below.

Configuration of OAuth in Frameleaf System Settings

| Setting                      | Value                                                               |
| ---------------------------- | ------------------------------------------------------------------- |
| Issuer URL                   | `https://authentik.example.com/application/o/frameleaf/`            |
| Client ID                    | AFCj2rM1f4rps**\*\*\*\***\***\*\*\*\***lCLEum6hH9...                |
| Client Secret                | 0v89FXkQOWO\***\*\*\*\*\***\*\*\***\*\*\*\*\***mprbvXD549HH6s1iw... |
| Scope                        | openid email profile                                                |
| Signing Algorithm            | RS256                                                               |
| Storage Label Claim          | preferred_username                                                  |
| Storage Quota Claim          | frameleaf_quota                                                     |
| Default Storage Quota (GiB)  | 0 (empty for unlimited quota)                                       |
| Button Text                  | Sign in with Authentik (optional)                                   |
| Auto Register                | Enabled (optional)                                                  |
| Auto Launch                  | Enabled (optional)                                                  |
| Mobile Redirect URI Override | Disable                                                             |
| Mobile Redirect URI          |                                                                     |

</details>

<details>
<summary>Google Example</summary>

### Google Example

Here's an example of OAuth configured for Google:

Configuration of Authorised redirect URIs (Google Console)

In the OAuth client's **Authorised redirect URIs**, select **Add URI** for each of these, then save:

1. `https://photos.example.com/auth/login`
2. `https://photos.example.com/user-settings`
3. `https://photos.example.com/api/oauth/mobile-redirect`

Google notes that changes can take from five minutes to a few hours to apply.

Configuration of OAuth in Frameleaf System Settings

| Setting                      | Value                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Issuer URL                   | `https://accounts.google.com`                                                |
| Client ID                    | 7\***\*\*\*\*\*\*\***\*\*\***\*\*\*\*\*\*\***vuls.apps.googleusercontent.com |
| Client Secret                | G\***\*\*\*\*\*\*\***\*\*\***\*\*\*\*\*\*\***OO                              |
| Scope                        | openid email profile                                                         |
| Signing Algorithm            | RS256                                                                        |
| Storage Label Claim          | preferred_username                                                           |
| Storage Quota Claim          | frameleaf_quota                                                              |
| Default Storage Quota (GiB)  | 0 (empty for unlimited quota)                                                |
| Button Text                  | Sign in with Google (optional)                                               |
| Auto Register                | Enabled (optional)                                                           |
| Auto Launch                  | Enabled                                                                      |
| Mobile Redirect URI Override | Enabled (required)                                                           |
| Mobile Redirect URI          | `https://photos.example.com/api/oauth/mobile-redirect`                       |

</details>

<details>
<summary>Keycloak Example</summary>

### Keycloak Example

Here's an example of OAuth configured for Keycloak:

Create a frameleaf client on your Keycloak Realm.

1. **General settings**: create an OpenID Connect client and set its **Client ID** (the value you enter as Client ID below).
2. **Access settings**: set **Root URL**, **Home URL** and **Admin URL** to your server address (for example `https://photos.example.com`). Under **Valid redirect URIs**, add `https://photos.example.com/auth/login`, `https://photos.example.com/user-settings` and the mobile callback described in [Mobile Redirect URI](#mobile-redirect-uri). Set **Valid post logout redirect URIs** and **Web origins** to `+`.
3. **Capability config**: set it up as shown below.

<img src={require('./img/keycloak-capability-config.webp').default} width='100%' title="Keycloak Client Capability Configuration" />

Configuration of OAuth in Frameleaf System Settings

| Setting                      | Value                                                    |
| ---------------------------- | -------------------------------------------------------- |
| Issuer URL                   | `https://<KEYCLOAK_DOMAIN>/realms/<YOUR_REALM>`          |
| Client ID                    | frameleaf                                                |
| Client Secret                | can be obtained from Clients -> frameleaf -> Credentials |
| Scope                        | openid email profile                                     |
| Signing Algorithm            | RS256                                                    |
| Storage Label Claim          | preferred_username                                       |
| Role Claim                   | frameleaf_role                                           |
| Storage Quota Claim          | frameleaf_quota                                          |
| Default Storage Quota (GiB)  | 0 (empty for unlimited quota)                            |
| Button Text                  | Sign in with Keycloak (recommended)                      |
| Auto Register                | Enabled (optional)                                       |
| Auto Launch                  | Enabled (optional)                                       |
| Mobile Redirect URI Override | Disabled                                                 |
| Mobile Redirect URI          |                                                          |

Role Claim can be managed via Client Role. Remember to create a mapper with claim name `frameleaf_role`.

</details>

[oidc]: https://openid.net/connect/
