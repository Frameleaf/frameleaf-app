# Server API — Authentication 1

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## signUpAdmin

`POST /api/auth/admin-sign-up`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/auth.controller.ts#L56).

Register admin

Permission: `See authentication declaration`. Admin only: `false`.

Models: [SignUpDto](models-31.md#signupdto), [UserAdminResponseDto](models-37.md#useradminresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('auth')
@Post('admin-sign-up')
@Endpoint({
    summary: 'Register admin',
    description: 'Create the first admin user in the system.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
@Authenticated({ public: true, setup: true })
@RateLimited(RATE_LIMITS.frameleafSetup)
```

Complete operation contract:

```json
{
  "description": "Create the first admin user in the system.",
  "operationId": "signUpAdmin",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SignUpDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/UserAdminResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Register admin",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-state": "Stable"
}
```

## changePassword

`POST /api/auth/change-password`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/auth.controller.ts#L80).

Change password

Permission: `auth.changePassword`. Admin only: `false`.

Models: [ChangePasswordDto](models-07.md#changepassworddto), [UserAdminResponseDto](models-37.md#useradminresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('auth')
@Post('change-password')
@Authenticated({ permission: Permission.AuthChangePassword })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Change password',
    description: 'Change the password of the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Change the password of the current user.",
  "operationId": "changePassword",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ChangePasswordDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/UserAdminResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Change password",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "auth.changePassword",
  "x-immich-state": "Stable"
}
```

## login

`POST /api/auth/login`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/auth.controller.ts#L31).

Login

Permission: `See authentication declaration`. Admin only: `false`.

Models: [LoginCredentialDto](models-14.md#logincredentialdto), [LoginResponseDto](models-14.md#loginresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('auth')
@Post('login')
@Endpoint({
    summary: 'Login',
    description: 'Login with username and password and receive a session token.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
@Authenticated({ public: true })
@RateLimited(RATE_LIMITS.login)
```

Complete operation contract:

```json
{
  "description": "Login with username and password and receive a session token.",
  "operationId": "login",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/LoginCredentialDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LoginResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Login",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-state": "Stable"
}
```

## logout

`POST /api/auth/logout`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/auth.controller.ts#L92).

Logout

Permission: `See authentication declaration`. Admin only: `false`.

Models: [LogoutResponseDto](models-14.md#logoutresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('auth')
@Post('logout')
@Authenticated()
@RemoteSignInExempt()
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Logout',
    description: 'Logout the current user and invalidate the session token.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Logout the current user and invalidate the session token.",
  "operationId": "logout",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LogoutResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Logout",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-state": "Stable"
}
```

## resetPinCode

`DELETE /api/auth/pin-code`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/auth.controller.ts#L154).

Reset pin code

Permission: `pinCode.delete`. Admin only: `false`.

Models: [PinCodeResetDto](models-26.md#pincoderesetdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('auth')
@Delete('pin-code')
@Authenticated({ permission: Permission.PinCodeDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Reset pin code',
    description: 'Reset the pin code for the current user by providing the account password',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Reset the pin code for the current user by providing the account password",
  "operationId": "resetPinCode",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PinCodeResetDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "204": {
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Reset pin code",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "pinCode.delete",
  "x-immich-state": "Stable"
}
```

## setupPinCode

`POST /api/auth/pin-code`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/auth.controller.ts#L130).

Setup pin code

Permission: `pinCode.create`. Admin only: `false`.

Models: [PinCodeSetupDto](models-26.md#pincodesetupdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('auth')
@Post('pin-code')
@Authenticated({ permission: Permission.PinCodeCreate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Setup pin code',
    description: 'Setup a new pin code for the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Setup a new pin code for the current user.",
  "operationId": "setupPinCode",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PinCodeSetupDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "204": {
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Setup pin code",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "pinCode.create",
  "x-immich-state": "Stable"
}
```

## changePinCode

`PUT /api/auth/pin-code`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/auth.controller.ts#L142).

Change pin code

Permission: `pinCode.update`. Admin only: `false`.

Models: [PinCodeChangeDto](models-26.md#pincodechangedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('auth')
@Put('pin-code')
@Authenticated({ permission: Permission.PinCodeUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Change pin code',
    description: 'Change the pin code for the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Change the pin code for the current user.",
  "operationId": "changePinCode",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PinCodeChangeDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "204": {
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Change pin code",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "pinCode.update",
  "x-immich-state": "Stable"
}
```

## lockAuthSession

`POST /api/auth/session/lock`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/auth.controller.ts#L178).

Lock auth session

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('auth')
@Post('session/lock')
@Authenticated()
@Endpoint({
    summary: 'Lock auth session',
    description: 'Remove elevated access to locked assets from the current session.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
@HttpCode(HttpStatus.NO_CONTENT)
```

Complete operation contract:

```json
{
  "description": "Remove elevated access to locked assets from the current session.",
  "operationId": "lockAuthSession",
  "parameters": [],
  "responses": {
    "204": {
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Lock auth session",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-state": "Stable"
}
```

## unlockAuthSession

`POST /api/auth/session/unlock`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/auth.controller.ts#L166).

Unlock auth session

Permission: `See authentication declaration`. Admin only: `false`.

Models: [SessionUnlockDto](models-31.md#sessionunlockdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('auth')
@Post('session/unlock')
@Authenticated()
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Unlock auth session',
    description: 'Temporarily grant the session elevated access to locked assets by providing the correct PIN code.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Temporarily grant the session elevated access to locked assets by providing the correct PIN code.",
  "operationId": "unlockAuthSession",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SessionUnlockDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "204": {
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Unlock auth session",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-state": "Stable"
}
```

## getAuthStatus

`GET /api/auth/status`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/auth.controller.ts#L117).

Retrieve auth status

Permission: `See authentication declaration`. Admin only: `false`.

Models: [AuthStatusResponseDto](models-06.md#authstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('auth')
@Get('status')
@Authenticated({ refreshElevation: false })
@Endpoint({
    summary: 'Retrieve auth status',
    description:
      'Get information about the current session, including whether the user has a password, and if the session can access locked assets.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Get information about the current session, including whether the user has a password, and if the session can access locked assets.",
  "operationId": "getAuthStatus",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AuthStatusResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Retrieve auth status",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-state": "Stable"
}
```

## validateAccessToken

`POST /api/auth/validateToken`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/auth.controller.ts#L68).

Validate access token

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ValidateAccessTokenResponseDto](models-38.md#validateaccesstokenresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('auth')
@Post('validateToken')
@Endpoint({
    summary: 'Validate access token',
    description: 'Validate the current authorization method is still valid.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
@Authenticated({ permission: false })
@HttpCode(HttpStatus.OK)
```

Complete operation contract:

```json
{
  "description": "Validate the current authorization method is still valid.",
  "operationId": "validateAccessToken",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ValidateAccessTokenResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Validate access token",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-state": "Stable"
}
```

## startOAuth

`POST /api/oauth/authorize`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/oauth.controller.ts#L57).

Start OAuth

Permission: `See authentication declaration`. Admin only: `false`.

Models: [OAuthAuthorizeResponseDto](models-18.md#oauthauthorizeresponsedto), [OAuthConfigDto](models-18.md#oauthconfigdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth')
@Post('authorize')
@Authenticated({ public: true })
@Endpoint({
    summary: 'Start OAuth',
    description: 'Initiate the OAuth authorization process.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Initiate the OAuth authorization process.",
  "operationId": "startOAuth",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/OAuthConfigDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/OAuthAuthorizeResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Start OAuth",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-state": "Stable"
}
```

## logoutOAuth

`POST /api/oauth/backchannel-logout`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/oauth.controller.ts#L140).

Backchannel OAuth logout

Permission: `See authentication declaration`. Admin only: `false`.

Models: [OAuthBackchannelLogoutDto](models-18.md#oauthbackchannellogoutdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth')
@Post('backchannel-logout')
@Authenticated({ public: true })
@HttpCode(HttpStatus.OK)
@ApiConsumes('application/x-www-form-urlencoded')
@Endpoint({
    summary: 'Backchannel OAuth logout',
    description:
      'Logout the OAuth account and invalidate the session specified by the sid claim or all sessions if the sid claim is not present.',
    history: new HistoryBuilder().added('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Logout the OAuth account and invalidate the session specified by the sid claim or all sessions if the sid claim is not present.",
  "operationId": "logoutOAuth",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/x-www-form-urlencoded": {
        "schema": {
          "$ref": "#/components/schemas/OAuthBackchannelLogoutDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "description": ""
    }
  },
  "summary": "Backchannel OAuth logout",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v2",
      "state": "Added"
    }
  ]
}
```

## finishOAuth

`POST /api/oauth/callback`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/oauth.controller.ts#L83).

Finish OAuth

Permission: `See authentication declaration`. Admin only: `false`.

Models: [LoginResponseDto](models-14.md#loginresponsedto), [OAuthCallbackDto](models-18.md#oauthcallbackdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth')
@Post('callback')
@Authenticated({ public: true })
@RateLimited(RATE_LIMITS.oauthCallback)
@Endpoint({
    summary: 'Finish OAuth',
    description: 'Complete the OAuth authorization process by exchanging the authorization code for a session token.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Complete the OAuth authorization process by exchanging the authorization code for a session token.",
  "operationId": "finishOAuth",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/OAuthCallbackDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LoginResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Finish OAuth",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-state": "Stable"
}
```

## redirectOAuthToFrameleafMobile

`GET /api/oauth/frameleaf-mobile-redirect`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/oauth.controller.ts#L41).

Redirect OAuth to the Frameleaf mobile app

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth')
@Get('frameleaf-mobile-redirect')
@Authenticated({ public: true })
@Redirect()
@Endpoint({
    summary: 'Redirect OAuth to the Frameleaf mobile app',
    description:
      'Requests to this URL are automatically forwarded to the Frameleaf mobile app (frameleaf-auth:///oauth-callback), and is used when an identity provider only accepts HTTP callbacks.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Requests to this URL are automatically forwarded to the Frameleaf mobile app (frameleaf-auth:///oauth-callback), and is used when an identity provider only accepts HTTP callbacks.",
  "operationId": "redirectOAuthToFrameleafMobile",
  "parameters": [],
  "responses": {
    "200": {
      "description": ""
    }
  },
  "summary": "Redirect OAuth to the Frameleaf mobile app",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ]
}
```

## startFrameleafSignIn

`POST /api/oauth/frameleaf/authorize`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/frameleaf-auth.controller.ts#L34).

Start Sign in with Frameleaf

Permission: `See authentication declaration`. Admin only: `false`.

Models: [OAuthAuthorizeResponseDto](models-18.md#oauthauthorizeresponsedto), [OAuthConfigDto](models-18.md#oauthconfigdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth/frameleaf')
@Post('authorize')
@Authenticated({ public: true })
@RateLimited(RATE_LIMITS.frameleafSignIn)
@Endpoint({
    operationId: 'startFrameleafSignIn',
    summary: 'Start Sign in with Frameleaf',
    description:
      'The Frameleaf authorization URL for one of the callbacks registered for this server. PKCE is used when the provider advertises it.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The Frameleaf authorization URL for one of the callbacks registered for this server. PKCE is used when the provider advertises it.",
  "operationId": "startFrameleafSignIn",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/OAuthConfigDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/OAuthAuthorizeResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Start Sign in with Frameleaf",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## finishFrameleafSignIn

`POST /api/oauth/frameleaf/callback`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/frameleaf-auth.controller.ts#L63).

Finish Sign in with Frameleaf

Permission: `See authentication declaration`. Admin only: `false`.

Models: [LoginResponseDto](models-14.md#loginresponsedto), [OAuthCallbackDto](models-18.md#oauthcallbackdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth/frameleaf')
@Post('callback')
@Authenticated({ public: true })
@RateLimited(RATE_LIMITS.frameleafSignIn)
@Endpoint({
    operationId: 'finishFrameleafSignIn',
    summary: 'Finish Sign in with Frameleaf',
    description:
      'Exchanges the authorization code, requires a verified email, links or creates the account Frameleaf Cloud authorized, and signs in with a session Frameleaf Cloud can end.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Exchanges the authorization code, requires a verified email, links or creates the account Frameleaf Cloud authorized, and signs in with a session Frameleaf Cloud can end.",
  "operationId": "finishFrameleafSignIn",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/OAuthCallbackDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LoginResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Finish Sign in with Frameleaf",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## exchangeFrameleafToken

`POST /api/oauth/frameleaf/exchange`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/frameleaf-auth.controller.ts#L85).

Sign in with a Frameleaf account token

Permission: `See authentication declaration`. Admin only: `false`.

Models: [FrameleafTokenExchangeDto](models-12.md#frameleaftokenexchangedto), [FrameleafTokenExchangeErrorDto](models-12.md#frameleaftokenexchangeerrordto), [LoginResponseDto](models-14.md#loginresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth/frameleaf')
@Post('exchange')
@Authenticated({ public: true })
@RateLimited(RATE_LIMITS.frameleafSignIn)
@Endpoint({
    operationId: 'exchangeFrameleafToken',
    summary: 'Sign in with a Frameleaf account token',
    description:
      'For the Frameleaf apps: exchanges a token the Frameleaf identity provider minted for this server (OAuth token exchange) for a session here, without a browser. The token is verified like a Sign in with Frameleaf ID token (the linked issuer, this server as its audience, the signature, its expiry and the instance-access claims), can be used once, and is at most two minutes old. The account is matched, linked or created as in Sign in with Frameleaf, and the session is a Sign in with Frameleaf session: a back-channel logout, unlinking the Frameleaf account or Frameleaf Cloud removing access ends it. Every refusal carries a FrameleafTokenExchangeErrorCode in `code`.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
@ApiResponse({
    status: 400,
    type: FrameleafTokenExchangeErrorDto,
    description:
      'frameleaf_exchange_not_linked, frameleaf_exchange_sign_in_off, frameleaf_exchange_email_unverified, frameleaf_exchange_account_removed or frameleaf_exchange_account_conflict',
  })
@ApiResponse({
    status: 401,
    type: FrameleafTokenExchangeErrorDto,
    description:
      'frameleaf_exchange_invalid, frameleaf_exchange_wrong_audience, frameleaf_exchange_expired or frameleaf_exchange_replayed',
  })
@ApiResponse({
    status: 403,
    type: FrameleafTokenExchangeErrorDto,
    description: 'frameleaf_exchange_no_access: the account has no access to this server, or it was removed',
  })
```

Complete operation contract:

```json
{
  "description": "For the Frameleaf apps: exchanges a token the Frameleaf identity provider minted for this server (OAuth token exchange) for a session here, without a browser. The token is verified like a Sign in with Frameleaf ID token (the linked issuer, this server as its audience, the signature, its expiry and the instance-access claims), can be used once, and is at most two minutes old. The account is matched, linked or created as in Sign in with Frameleaf, and the session is a Sign in with Frameleaf session: a back-channel logout, unlinking the Frameleaf account or Frameleaf Cloud removing access ends it. Every refusal carries a FrameleafTokenExchangeErrorCode in `code`.",
  "operationId": "exchangeFrameleafToken",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/FrameleafTokenExchangeDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LoginResponseDto"
          }
        }
      },
      "description": ""
    },
    "400": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafTokenExchangeErrorDto"
          }
        }
      },
      "description": "frameleaf_exchange_not_linked, frameleaf_exchange_sign_in_off, frameleaf_exchange_email_unverified, frameleaf_exchange_account_removed or frameleaf_exchange_account_conflict"
    },
    "401": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafTokenExchangeErrorDto"
          }
        }
      },
      "description": "frameleaf_exchange_invalid, frameleaf_exchange_wrong_audience, frameleaf_exchange_expired or frameleaf_exchange_replayed"
    },
    "403": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafTokenExchangeErrorDto"
          }
        }
      },
      "description": "frameleaf_exchange_no_access: the account has no access to this server, or it was removed"
    }
  },
  "summary": "Sign in with a Frameleaf account token",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## createFrameleafHandoff

`POST /api/oauth/frameleaf/handoff`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/frameleaf-auth.controller.ts#L121).

Hand a Sign in with Frameleaf session to another address

Permission: `See authentication declaration`. Admin only: `false`.

Models: [FrameleafHandoffCreateDto](models-11.md#frameleafhandoffcreatedto), [FrameleafHandoffResponseDto](models-11.md#frameleafhandoffresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth/frameleaf')
@Post('handoff')
@Authenticated()
@RateLimited(RATE_LIMITS.frameleafSignIn)
@Endpoint({
    operationId: 'createFrameleafHandoff',
    summary: 'Hand a Sign in with Frameleaf session to another address',
    description:
      'A single-use code, valid for a minute, that signs you in on another address of this server (for example your home address). Only a Sign in with Frameleaf session can be handed over, and only to a home address this server published.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "A single-use code, valid for a minute, that signs you in on another address of this server (for example your home address). Only a Sign in with Frameleaf session can be handed over, and only to a home address this server published.",
  "operationId": "createFrameleafHandoff",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/FrameleafHandoffCreateDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafHandoffResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Hand a Sign in with Frameleaf session to another address",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## redeemFrameleafHandoff

`POST /api/oauth/frameleaf/handoff/redeem`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/frameleaf-auth.controller.ts#L135).

Sign in with a handoff code

Permission: `See authentication declaration`. Admin only: `false`.

Models: [FrameleafHandoffRedeemDto](models-11.md#frameleafhandoffredeemdto), [LoginResponseDto](models-14.md#loginresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth/frameleaf')
@Post('handoff/redeem')
@Authenticated({ public: true })
@RateLimited(RATE_LIMITS.frameleafSignIn)
@Endpoint({
    operationId: 'redeemFrameleafHandoff',
    summary: 'Sign in with a handoff code',
    description: 'Exchanges a handoff code for a new session tagged like the one that created it.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Exchanges a handoff code for a new session tagged like the one that created it.",
  "operationId": "redeemFrameleafHandoff",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/FrameleafHandoffRedeemDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LoginResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Sign in with a handoff code",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## unlinkFrameleafAccount

`DELETE /api/oauth/frameleaf/link`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/frameleaf-auth.controller.ts#L200).

Unlink your Frameleaf account

Permission: `frameleafAccount.update`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth/frameleaf')
@Delete('link')
@Authenticated({ permission: Permission.FrameleafAccountUpdate })
@RateLimited(RATE_LIMITS.frameleafSignIn)
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    operationId: 'unlinkFrameleafAccount',
    summary: 'Unlink your Frameleaf account',
    description:
      'Unlinks your Frameleaf account and ends your other Sign in with Frameleaf sessions. Signing in at home is unchanged.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Unlinks your Frameleaf account and ends your other Sign in with Frameleaf sessions. Signing in at home is unchanged.",
  "operationId": "unlinkFrameleafAccount",
  "parameters": [],
  "responses": {
    "204": {
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Unlink your Frameleaf account",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "frameleafAccount.update",
  "x-immich-state": "Alpha"
}
```

## getFrameleafAccountLink

`GET /api/oauth/frameleaf/link`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/frameleaf-auth.controller.ts#L153).

Get your Frameleaf account link

Permission: `frameleafAccount.read`. Admin only: `false`.

Models: [FrameleafAccountLinkResponseDto](models-11.md#frameleafaccountlinkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth/frameleaf')
@Get('link')
@Authenticated({ permission: Permission.FrameleafAccountRead })
@RateLimited(RATE_LIMITS.frameleafSignIn)
@Endpoint({
    operationId: 'getFrameleafAccountLink',
    summary: 'Get your Frameleaf account link',
    description: 'Whether your account here is linked to a Frameleaf account, and which one.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Whether your account here is linked to a Frameleaf account, and which one.",
  "operationId": "getFrameleafAccountLink",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafAccountLinkResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Get your Frameleaf account link",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "frameleafAccount.read",
  "x-immich-state": "Alpha"
}
```

## linkFrameleafAccount

`POST /api/oauth/frameleaf/link`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/frameleaf-auth.controller.ts#L166).

Link your Frameleaf account

Permission: `frameleafAccount.update`. Admin only: `false`.

Models: [FrameleafLinkDto](models-11.md#frameleaflinkdto), [FrameleafLinkResponseDto](models-11.md#frameleaflinkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth/frameleaf')
@Post('link')
@Authenticated({ permission: Permission.FrameleafAccountUpdate })
@RateLimited(RATE_LIMITS.frameleafSignIn)
@HttpCode(HttpStatus.OK)
@Endpoint({
    operationId: 'linkFrameleafAccount',
    summary: 'Link your Frameleaf account',
    description:
      'Links the Frameleaf account you just signed in with to your account here, so you can sign in with it when you are away from home. A verified email is required. If that Frameleaf account holds an admin share of this server on Frameleaf Cloud, you become an administrator here at once (roleChange: granted-admin) and the other administrators are notified. With preview: true nothing is linked yet: the response reports the role change and a confirmToken for link/confirm.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Links the Frameleaf account you just signed in with to your account here, so you can sign in with it when you are away from home. A verified email is required. If that Frameleaf account holds an admin share of this server on Frameleaf Cloud, you become an administrator here at once (roleChange: granted-admin) and the other administrators are notified. With preview: true nothing is linked yet: the response reports the role change and a confirmToken for link/confirm.",
  "operationId": "linkFrameleafAccount",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/FrameleafLinkDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafLinkResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Link your Frameleaf account",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "frameleafAccount.update",
  "x-immich-state": "Alpha"
}
```

## confirmFrameleafAccountLink

`POST /api/oauth/frameleaf/link/confirm`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/frameleaf-auth.controller.ts#L185).

Confirm linking your Frameleaf account

Permission: `frameleafAccount.update`. Admin only: `false`.

Models: [FrameleafLinkConfirmDto](models-11.md#frameleaflinkconfirmdto), [FrameleafLinkResponseDto](models-11.md#frameleaflinkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth/frameleaf')
@Post('link/confirm')
@Authenticated({ permission: Permission.FrameleafAccountUpdate })
@RateLimited(RATE_LIMITS.frameleafSignIn)
@HttpCode(HttpStatus.OK)
@Endpoint({
    operationId: 'confirmFrameleafAccountLink',
    summary: 'Confirm linking your Frameleaf account',
    description:
      'Links the Frameleaf account a preview reported, by its confirm token (valid for 10 minutes, for this session only). If the Frameleaf account holds an admin share of this server, you become an administrator here.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Links the Frameleaf account a preview reported, by its confirm token (valid for 10 minutes, for this session only). If the Frameleaf account holds an admin share of this server, you become an administrator here.",
  "operationId": "confirmFrameleafAccountLink",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/FrameleafLinkConfirmDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafLinkResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Confirm linking your Frameleaf account",
  "tags": [
    "Authentication"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "frameleafAccount.update",
  "x-immich-state": "Alpha"
}
```
