
// this file is generated — do not edit it


/// <reference types="@sveltejs/kit" />

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/private';
 * 
 * console.log(ENVIRONMENT); // => "production"
 * console.log(PUBLIC_BASE_URL); // => throws error during build
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/private' {
	export const CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL: string;
	export const CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES: string;
	export const CLAUDE_CODE_MESSAGING_TOKEN: string;
	export const NoDefaultCurrentDirectoryInExePath: string;
	export const CLAUDE_CODE_ENTRYPOINT: string;
	export const CLAUDE_EFFORT: string;
	export const SSL_CERT_FILE: string;
	export const NODE: string;
	export const INIT_CWD: string;
	export const SHELL: string;
	export const CLAUDE_CODE_OAUTH_SCOPES: string;
	export const CLAUDE_PREVIEW_CLASSIFIER_FLOOR: string;
	export const CLAUDE_CODE_HOST_SESSION_ID: string;
	export const BAGGAGE: string;
	export const TMPDIR: string;
	export const CLAUDE_CODE_EAGER_FLUSH: string;
	export const CLAUDE_CODE_CHILD_SESSION: string;
	export const CLAUDE_PID: string;
	export const npm_config_global_prefix: string;
	export const MallocNanoZone: string;
	export const CLAUDE_AGENT_SDK_VERSION: string;
	export const USE_LOCAL_OAUTH: string;
	export const COLOR: string;
	export const npm_config_noproxy: string;
	export const npm_config_local_prefix: string;
	export const AI_AGENT: string;
	export const GIT_EDITOR: string;
	export const USER: string;
	export const CLAUDE_CODE_DISABLE_TERMINAL_TITLE: string;
	export const COMMAND_MODE: string;
	export const API_TIMEOUT_MS: string;
	export const npm_config_globalconfig: string;
	export const SSH_AUTH_SOCK: string;
	export const CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: string;
	export const __CF_USER_TEXT_ENCODING: string;
	export const npm_execpath: string;
	export const CLAUDE_CODE_DESKTOP_APP_VERSION: string;
	export const CLAUDE_CODE_REPORT_FINDINGS: string;
	export const PATH: string;
	export const MCP_CONNECTION_NONBLOCKING: string;
	export const LaunchInstanceID: string;
	export const npm_config_engine_strict: string;
	export const npm_package_json: string;
	export const __CFBundleIdentifier: string;
	export const CLAUDE_CODE_TERMINAL_MCP_TOOLS: string;
	export const npm_config_init_module: string;
	export const npm_config_userconfig: string;
	export const PWD: string;
	export const npm_command: string;
	export const EDITOR: string;
	export const npm_lifecycle_event: string;
	export const npm_package_name: string;
	export const NODE_PATH: string;
	export const XPC_FLAGS: string;
	export const NODE_USE_SYSTEM_CA: string;
	export const npm_config_npm_version: string;
	export const CLAUDE_CODE_SESSION_ATTENDED: string;
	export const CLAUDE_FLOW_HOOKS_ENABLED: string;
	export const npm_config_node_gyp: string;
	export const XPC_SERVICE_NAME: string;
	export const npm_package_version: string;
	export const HOME: string;
	export const CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: string;
	export const SHLVL: string;
	export const ANTHROPIC_BASE_URL: string;
	export const CLAUDE_CODE_DISABLE_CRON: string;
	export const CLAUDE_CODE_EXECPATH: string;
	export const MCP_SERVER_CONNECTION_BATCH_SIZE: string;
	export const DISABLE_MICROCOMPACT: string;
	export const LOGNAME: string;
	export const CLAUDE_FLOW_V3_ENABLED: string;
	export const npm_config_cache: string;
	export const npm_lifecycle_script: string;
	export const COREPACK_ENABLE_AUTO_PIN: string;
	export const CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: string;
	export const npm_config_user_agent: string;
	export const DISABLE_AUTOUPDATER: string;
	export const CLAUDE_CODE_SESSION_ID: string;
	export const OSLogRateLimit: string;
	export const SECURITYSESSIONID: string;
	export const CLAUDE_CODE_MESSAGING_SOCKET: string;
	export const CLAUDECODE: string;
	export const USE_STAGING_OAUTH: string;
	export const npm_config_prefix: string;
	export const npm_node_execpath: string;
	export const TEST: string;
	export const VITEST: string;
	export const NODE_ENV: string;
	export const VIPSHOME: string;
	export const PROD: string;
	export const DEV: string;
	export const BASE_URL: string;
	export const MODE: string;
}

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/public';
 * 
 * console.log(ENVIRONMENT); // => throws error during build
 * console.log(PUBLIC_BASE_URL); // => "http://site.com"
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/public' {
	
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/private';
 * 
 * console.log(env.ENVIRONMENT); // => "production"
 * console.log(env.PUBLIC_BASE_URL); // => undefined
 * ```
 */
declare module '$env/dynamic/private' {
	export const env: {
		CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL: string;
		CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES: string;
		CLAUDE_CODE_MESSAGING_TOKEN: string;
		NoDefaultCurrentDirectoryInExePath: string;
		CLAUDE_CODE_ENTRYPOINT: string;
		CLAUDE_EFFORT: string;
		SSL_CERT_FILE: string;
		NODE: string;
		INIT_CWD: string;
		SHELL: string;
		CLAUDE_CODE_OAUTH_SCOPES: string;
		CLAUDE_PREVIEW_CLASSIFIER_FLOOR: string;
		CLAUDE_CODE_HOST_SESSION_ID: string;
		BAGGAGE: string;
		TMPDIR: string;
		CLAUDE_CODE_EAGER_FLUSH: string;
		CLAUDE_CODE_CHILD_SESSION: string;
		CLAUDE_PID: string;
		npm_config_global_prefix: string;
		MallocNanoZone: string;
		CLAUDE_AGENT_SDK_VERSION: string;
		USE_LOCAL_OAUTH: string;
		COLOR: string;
		npm_config_noproxy: string;
		npm_config_local_prefix: string;
		AI_AGENT: string;
		GIT_EDITOR: string;
		USER: string;
		CLAUDE_CODE_DISABLE_TERMINAL_TITLE: string;
		COMMAND_MODE: string;
		API_TIMEOUT_MS: string;
		npm_config_globalconfig: string;
		SSH_AUTH_SOCK: string;
		CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: string;
		__CF_USER_TEXT_ENCODING: string;
		npm_execpath: string;
		CLAUDE_CODE_DESKTOP_APP_VERSION: string;
		CLAUDE_CODE_REPORT_FINDINGS: string;
		PATH: string;
		MCP_CONNECTION_NONBLOCKING: string;
		LaunchInstanceID: string;
		npm_config_engine_strict: string;
		npm_package_json: string;
		__CFBundleIdentifier: string;
		CLAUDE_CODE_TERMINAL_MCP_TOOLS: string;
		npm_config_init_module: string;
		npm_config_userconfig: string;
		PWD: string;
		npm_command: string;
		EDITOR: string;
		npm_lifecycle_event: string;
		npm_package_name: string;
		NODE_PATH: string;
		XPC_FLAGS: string;
		NODE_USE_SYSTEM_CA: string;
		npm_config_npm_version: string;
		CLAUDE_CODE_SESSION_ATTENDED: string;
		CLAUDE_FLOW_HOOKS_ENABLED: string;
		npm_config_node_gyp: string;
		XPC_SERVICE_NAME: string;
		npm_package_version: string;
		HOME: string;
		CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: string;
		SHLVL: string;
		ANTHROPIC_BASE_URL: string;
		CLAUDE_CODE_DISABLE_CRON: string;
		CLAUDE_CODE_EXECPATH: string;
		MCP_SERVER_CONNECTION_BATCH_SIZE: string;
		DISABLE_MICROCOMPACT: string;
		LOGNAME: string;
		CLAUDE_FLOW_V3_ENABLED: string;
		npm_config_cache: string;
		npm_lifecycle_script: string;
		COREPACK_ENABLE_AUTO_PIN: string;
		CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: string;
		npm_config_user_agent: string;
		DISABLE_AUTOUPDATER: string;
		CLAUDE_CODE_SESSION_ID: string;
		OSLogRateLimit: string;
		SECURITYSESSIONID: string;
		CLAUDE_CODE_MESSAGING_SOCKET: string;
		CLAUDECODE: string;
		USE_STAGING_OAUTH: string;
		npm_config_prefix: string;
		npm_node_execpath: string;
		TEST: string;
		VITEST: string;
		NODE_ENV: string;
		VIPSHOME: string;
		PROD: string;
		DEV: string;
		BASE_URL: string;
		MODE: string;
		[key: `PUBLIC_${string}`]: undefined;
		[key: `${string}`]: string | undefined;
	}
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://example.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.ENVIRONMENT); // => undefined, not public
 * console.log(env.PUBLIC_BASE_URL); // => "http://example.com"
 * ```
 * 
 * ```
 * 
 * ```
 */
declare module '$env/dynamic/public' {
	export const env: {
		[key: `PUBLIC_${string}`]: string | undefined;
	}
}
