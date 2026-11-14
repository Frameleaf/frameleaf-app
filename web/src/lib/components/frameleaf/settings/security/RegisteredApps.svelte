<script lang="ts">
  /**
   * FL-860: the apps registered for connecting to this server (Sign-in settings, administrators),
   * each with who made it when Frameleaf checked it, whether it registered itself, and how many
   * people allow it; Remove ends everyone's access to it at once (FL-803 `DELETE admin/oauth/apps`).
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import {
    createOAuthAppClient,
    Preset,
    deleteOAuthAppClient,
    getOAuthAppClients,
    isHttpError,
    type OAuthAppAdminClientDto,
    type OAuthAppCreateClientResponseDto,
  } from '@frameleaf/sdk';
  import { copyToClipboard } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { mdiApplicationOutline, mdiChatOutline, mdiCreationOutline, mdiHomeAutomation } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let apps = $state<OAuthAppAdminClientDto[]>();
  let failed = $state(false);
  let removing = $state<OAuthAppAdminClientDto>();
  let open = $state(false);
  let working = $state(false);
  let said = $state('');
  let setup = $state(false);
  let preset = $state('make');
  let appName = $state('');
  let callback = $state('');
  let registered = $state<OAuthAppCreateClientResponseDto>();

  const register = async () => {
    working = true;
    registered = undefined;
    try {
      registered = await createOAuthAppClient({
        oAuthAppCreateClientDto: {
          name: preset === 'make' ? 'Make' : preset === 'zapier' ? 'Zapier' : appName.trim(),
          redirectUris: [callback.trim()],
          ...((preset === Preset.Make || preset === Preset.Zapier) && { preset }),
        },
      });
      await refresh();
    } catch (error) {
      handleError(error, $t('frameleaf_connect_setup_failed'));
    } finally {
      working = false;
    }
  };

  const refresh = async () => {
    try {
      apps = await getOAuthAppClients();
      failed = false;
    } catch {
      failed = true;
    }
  };
  onMount(() => void refresh());

  const ICONS: Record<string, string> = {
    claude: mdiCreationOutline,
    chatgpt: mdiChatOutline,
    homeassistant: mdiHomeAutomation,
  };
  const date = (iso: string) => DateTime.fromISO(iso, { locale: $locale }).toLocaleString(DateTime.DATE_MED);

  const ask = (app: OAuthAppAdminClientDto) => {
    removing = app;
    open = true;
  };

  const remove = async () => {
    if (!removing) {
      return;
    }
    working = true;
    const name = removing.client.name;
    try {
      await deleteOAuthAppClient({ id: removing.client.id });
      said = $t('frameleaf_apps_admin_removed', { values: { name } });
    } catch (error) {
      // 404: someone already removed it; anything else is a real failure to report
      if (!(isHttpError(error) && error.status === 404)) {
        handleError(error, $t('frameleaf_apps_admin_remove_failed', { values: { name } }));
      }
    } finally {
      working = false;
      open = false;
      await refresh();
    }
  };
</script>

<Said message={said} onDismiss={() => (said = '')} />
<Button
  onclick={() => {
    setup = true;
    registered = undefined;
  }}>{$t('frameleaf_connect_setup_app')}</Button
>
<Dialog title={$t('frameleaf_connect_setup_app')} closeLabel={$t('close')} bind:open={setup}>
  <div class="setup">
    {#if registered}
      <p>{$t('frameleaf_connect_client_ready')}</p>
      <strong>{$t('frameleaf_apps_allow_details_app_id')}</strong>
      <code>{registered.clientId}</code>
      <Button onclick={() => copyToClipboard(registered!.clientId)}>{$t('frameleaf_apps_copy')}</Button>
      <strong>{$t('frameleaf_apps_allow_details_back')}</strong>
      {#each registered.redirectUris as uri (uri)}<code>{uri}</code>{/each}
    {:else}
      <Select
        label={$t('name')}
        value={preset}
        options={[
          { value: 'make', label: 'Make' },
          { value: 'zapier', label: 'Zapier' },
          { value: 'manual', label: $t('other') },
        ]}
        onChange={(value) => (preset = value)}
        disabled={working}
      />
      {#if preset === 'manual'}
        <Field label={$t('name')} value={appName} onChange={(value) => (appName = value)} disabled={working} />
      {/if}
      <Field
        label={$t('frameleaf_apps_allow_details_back')}
        value={callback}
        onChange={(value) => (callback = value)}
        describedBy="connect-callback-help"
        disabled={working}
      />
      <p id="connect-callback-help" class="hint">{$t('frameleaf_connect_callback_help')}</p>
    {/if}
  </div>
  {#snippet actions()}
    <Button onclick={() => (setup = false)}>{$t(registered ? 'frameleaf_apps_done' : 'cancel')}</Button>
    {#if !registered}<Button
        variant="primary"
        disabled={working || !callback.trim() || (preset === 'manual' && !appName.trim())}
        onclick={register}>{$t('create')}</Button
      >{/if}
  {/snippet}
</Dialog>
{#if failed}
  <p class="hint">{$t('frameleaf_apps_hero_error_body')}</p>
{:else if apps && apps.length === 0}
  <p class="hint">{$t('frameleaf_apps_admin_none')}</p>
{:else if apps}
  <ItemList>
    {#each apps as app (app.client.id)}
      <Item
        icon={(app.client.knownApp && ICONS[app.client.knownApp]) || mdiApplicationOutline}
        name={app.client.name}
        detail={app.client.verified && app.client.maker
          ? $t('frameleaf_apps_details_verified', { values: { maker: app.client.maker } })
          : $t('frameleaf_apps_details_unverified')}
        tone={app.activeUsers > 0 ? 'good' : 'off'}
        status={$t('frameleaf_apps_admin_users', { values: { count: app.activeUsers } })}
        note={app.selfRegistered
          ? $t('frameleaf_apps_admin_self_registered', { values: { date: date(app.createdAt) } })
          : $t('frameleaf_apps_admin_added', { values: { date: date(app.createdAt) } })}
      >
        {#snippet action()}
          <Button
            label={$t('frameleaf_apps_admin_remove_title', { values: { name: app.client.name } })}
            onclick={() => ask(app)}>{$t('frameleaf_apps_admin_remove')}</Button
          >
        {/snippet}
      </Item>
    {/each}
  </ItemList>
{/if}

{#if removing}
  <Dialog
    title={$t('frameleaf_apps_admin_remove_title', { values: { name: removing.client.name } })}
    closeLabel={$t('close')}
    bind:open
  >
    <p class="body">{$t('frameleaf_apps_admin_remove_body', { values: { name: removing.client.name } })}</p>
    {#snippet actions()}
      <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="danger" disabled={working} onclick={remove}>{$t('frameleaf_apps_admin_remove')}</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .hint {
    margin: 0;
    padding: var(--fl-space-3) 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .body {
    margin: 0;
  }
  .setup {
    display: grid;
    gap: var(--fl-space-3);
  }
  .setup code {
    overflow-wrap: anywhere;
  }
</style>
