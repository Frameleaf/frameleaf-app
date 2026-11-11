<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import {
    createMediaConnection,
    disconnectMediaConnection,
    getMediaConnections,
    MediaAuthenticationMethod,
    MediaConnectionStatus,
    refreshMediaConnection,
    type MediaAuthenticationMethod as AuthenticationMethod,
    type MediaConnectionResponseDto,
  } from '@frameleaf/sdk';
  import { onMount, tick } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import { mediaDate } from './boards-media';

  let { methods }: { methods: AuthenticationMethod[] } = $props();

  const supported = {
    bluesky: {
      label: 'Bluesky',
      domains: ['bsky.app', 'bsky.social'],
      method: MediaAuthenticationMethod.Credentials,
      replace: 'frameleaf_boards_media_replace_bluesky',
    },
    reddit: {
      label: 'Reddit',
      domains: ['reddit.com'],
      method: MediaAuthenticationMethod.Token,
      replace: 'frameleaf_boards_media_replace_reddit',
    },
  } as const;
  type Provider = keyof typeof supported;
  const providers = $derived(
    (Object.keys(supported) as Provider[]).filter((key) => methods.includes(supported[key].method)),
  );
  const controller = new AbortController();
  let connections = $state<MediaConnectionResponseDto[]>([]);
  let provider = $state<Provider>('bluesky');
  let form = $state<HTMLFormElement>();
  let secure = $state(false);
  let showForm = $state(false);
  let refreshing = $state<MediaConnectionResponseDto>();
  let disconnecting = $state<MediaConnectionResponseDto>();
  let loading = $state(true);
  let loadFailed = $state(false);
  let pending = $state(false);
  let failed = $state(false);
  let labelInput = $state<HTMLInputElement>();

  const load = async () => {
    loading = true;
    loadFailed = false;
    try {
      ({ connections } = await getMediaConnections({ signal: controller.signal }));
    } catch {
      loadFailed = true;
    } finally {
      loading = false;
    }
  };

  onMount(() => {
    secure = location.protocol === 'https:';
    void load();
    return () => {
      controller.abort();
      form?.reset();
    };
  });

  const clear = () => {
    form?.reset();
    showForm = false;
    refreshing = undefined;
    failed = false;
  };

  const edit = async (connection?: MediaConnectionResponseDto) => {
    clear();
    provider = (connection?.provider as Provider | undefined) ?? providers[0];
    refreshing = connection;
    showForm = true;
    await tick();
    labelInput?.focus();
  };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!secure || pending || !form || !providers.includes(provider)) {
      return;
    }
    const fields = new FormData(form);
    const label = String(fields.get('label') ?? '').trim();
    const site = supported[provider];
    const session = {
      domains: [...site.domains],
      ...(provider === 'bluesky'
        ? {
            username: String(fields.get('username') ?? '').trim(),
            password: String(fields.get('app-password') ?? '').trim(),
          }
        : {
            refreshToken: String(fields.get('refresh-token') ?? '').trim(),
            clientId: String(fields.get('client-id') ?? '').trim(),
            clientSecret: String(fields.get('client-secret') ?? '').trim() || undefined,
          }),
    };
    form.reset();
    pending = true;
    failed = false;
    try {
      if (refreshing) {
        const id = refreshing.id;
        const updated = await refreshMediaConnection({ id, mediaConnectionRefreshDto: { session } });
        connections = connections.map((value) => (value.id === id ? updated : value));
      } else {
        const created = await createMediaConnection({ mediaConnectionCreateDto: { provider, label, session } });
        connections = [created, ...connections];
      }
      clear();
    } catch {
      failed = true;
    } finally {
      pending = false;
    }
  };

  const disconnect = async () => {
    if (!disconnecting || pending) {
      return;
    }
    const id = disconnecting.id;
    pending = true;
    failed = false;
    try {
      const updated = await disconnectMediaConnection({ id });
      connections = connections.map((value) => (value.id === id ? updated : value));
      disconnecting = undefined;
    } catch {
      failed = true;
    } finally {
      pending = false;
    }
  };
</script>

<p>{$t('frameleaf_boards_media_site_privacy')}</p>
{#if methods.includes(MediaAuthenticationMethod.Cookies)}
  <p class="media-secondary">{$t('frameleaf_boards_media_cookie_access')}</p>
{/if}
{#if !secure}<p class="media-secondary">{$t('frameleaf_boards_media_https_required')}</p>{/if}
{#if failed}<InlineError compact message={$t('frameleaf_boards_media_connection_action_error')} />{/if}
{#if loading}
  <p role="status">{$t('loading')}</p>
{:else if loadFailed}
  <InlineError compact message={$t('frameleaf_boards_media_connections_error')} onRetry={load} />
{:else}
  {#if connections.length}
    <ul class="media-list">
      {#each connections as connection (connection.id)}
        <li>
          <strong>{connection.label}</strong>
          <span class="media-secondary">
            {connection.provider} · {$t(`frameleaf_boards_media_connection_${connection.status}`)}
          </span>
          <span class="media-secondary">
            {$t('frameleaf_boards_media_domains')} · {connection.domains.join(', ')}
          </span>
          <span class="media-secondary">
            {$t('frameleaf_boards_media_updated')} ·
            <time datetime={connection.updatedAt}>{mediaDate(connection.updatedAt, $locale)}</time>
          </span>
          {#if disconnecting?.id === connection.id}
            <p>{$t('frameleaf_boards_media_disconnect_hint')}</p>
            <div class="media-actions">
              <Button variant="danger" disabled={pending} onclick={() => void disconnect()}
                >{$t('frameleaf_boards_media_disconnect')}</Button
              >
              <Button disabled={pending} onclick={() => (disconnecting = undefined)}>{$t('cancel')}</Button>
            </div>
          {:else}
            <div class="media-actions">
              {#if secure && (providers as string[]).includes(connection.provider)}
                <Button disabled={showForm || !!disconnecting || pending} onclick={() => void edit(connection)}>
                  {$t(supported[connection.provider as Provider].replace)}
                </Button>
              {/if}
              {#if connection.status !== MediaConnectionStatus.Disconnected}
                <Button
                  disabled={showForm || !!disconnecting || pending}
                  onclick={() => {
                    failed = false;
                    disconnecting = connection;
                  }}
                >
                  {$t('frameleaf_boards_media_disconnect')}
                </Button>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p>{$t('frameleaf_boards_media_connections_empty')}</p>
  {/if}
  {#if secure && providers.length > 0 && !showForm}
    <div>
      <Button variant="primary" disabled={pending || !!disconnecting} onclick={() => void edit()}
        >{$t('frameleaf_boards_media_connect')}</Button
      >
    </div>
  {/if}
  {#if showForm}
    <form class="media-fields" autocomplete="off" bind:this={form} onsubmit={(event) => void save(event)}>
      <h3>{$t(refreshing ? supported[provider].replace : 'frameleaf_boards_media_connect')}</h3>
      {#if refreshing}
        <p><strong>{refreshing.label}</strong></p>
      {:else}
        <label class="media-field">
          {$t('frameleaf_boards_media_site')}
          <select bind:value={provider} disabled={pending}>
            {#each providers as value (value)}
              <option {value}>{supported[value].label}</option>
            {/each}
          </select>
        </label>
        <label class="media-field">
          {$t('frameleaf_boards_media_connection_name')}
          <input name="label" maxlength="255" bind:this={labelInput} required disabled={pending} />
        </label>
      {/if}
      <p class="media-secondary">{$t('frameleaf_boards_media_domains')} · {supported[provider].domains.join(', ')}</p>
      {#key provider}
        {#if provider === 'bluesky'}
          <label class="media-field">
            {$t('frameleaf_boards_media_bluesky_username')}
            <input
              name="username"
              maxlength="1024"
              spellcheck="false"
              autocapitalize="none"
              required
              disabled={pending}
            />
          </label>
          <label class="media-field">
            {$t('frameleaf_boards_media_app_password')}
            <input
              type="password"
              name="app-password"
              maxlength="8192"
              autocomplete="new-password"
              required
              disabled={pending}
            />
          </label>
        {:else}
          <p class="media-secondary">{$t('frameleaf_boards_media_reddit_hint')}</p>
          <label class="media-field">
            {$t('frameleaf_boards_media_reddit_token')}
            <input
              type="password"
              name="refresh-token"
              maxlength="16384"
              autocomplete="new-password"
              required
              disabled={pending}
            />
          </label>
          <label class="media-field">
            {$t('frameleaf_boards_media_reddit_client')}
            <input
              type="password"
              name="client-id"
              maxlength="1024"
              autocomplete="new-password"
              required
              disabled={pending}
            />
          </label>
          <label class="media-field">
            {$t('frameleaf_boards_media_reddit_secret')}
            <input
              type="password"
              name="client-secret"
              maxlength="8192"
              autocomplete="new-password"
              disabled={pending}
            />
          </label>
        {/if}
      {/key}
      <div class="media-actions">
        <Button type="submit" variant="primary" disabled={pending}>
          {$t(refreshing ? supported[provider].replace : 'frameleaf_boards_media_connect')}
        </Button>
        <Button disabled={pending} onclick={clear}>{$t('cancel')}</Button>
      </div>
    </form>
  {/if}
{/if}
