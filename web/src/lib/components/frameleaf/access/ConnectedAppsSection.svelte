<script lang="ts">
  /**
   * FL-860: Connected apps (Your sign-in & privacy), as mocked in FL-778
   * (`settings-v2/cloud/ConnectedApps.jsx`). The apps you allowed into your library, each with what
   * it can do, when and how it last connected, Details and Remove (which revokes its access on its
   * next request); how to connect an AI assistant (the library's assistant address, and steps for
   * Claude, ChatGPT and an app on your computer); and Home Assistant. Without remote access (a
   * Frameleaf plan) only the home-network address is shown, and the steps for assistants that run
   * on the web are replaced by why they can't reach the server.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Points from '$lib/components/frameleaf/settings/kit/Points.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Steps from '$lib/components/frameleaf/settings/kit/Steps.svelte';
  import {
    WEB_ASSISTANTS,
    accessSummary,
    assistantAddress,
    neverAllowed,
    plainAccess,
    staleMonths,
    type AssistantClient,
  } from '$lib/frameleaf/connected-apps';
  import { motionScrollBehavior } from '$lib/frameleaf/motion';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { copyToClipboard } from '$lib/utils';
  import { getOAuthAppGrants, isHttpError, revokeOAuthAppGrant, type OAuthAppGrantDto } from '@frameleaf/sdk';
  import { handleError } from '$lib/utils/handle-error';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiApplicationOutline,
    mdiChatOutline,
    mdiContentCopy,
    mdiCreationOutline,
    mdiHomeAutomation,
    mdiHomeOutline,
    mdiLinkVariantOff,
    mdiLockOutline,
    mdiOpenInNew,
    mdiPuzzleCheckOutline,
    mdiPuzzleOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Load = 'loading' | 'ready' | 'error';
  let load = $state<Load>('loading');
  let grants = $state<OAuthAppGrantDto[]>([]);
  let client = $state<AssistantClient>('claude');
  let showing = $state<{ step: 'details' | 'remove'; grant: OAuthAppGrantDto }>();
  let dialogOpen = $state(false);
  let working = $state(false);
  let said = $state('');

  const refresh = async () => {
    load = 'loading';
    try {
      grants = await getOAuthAppGrants();
      load = 'ready';
    } catch {
      load = 'error';
    }
  };
  /**
   * Whether this server answers at the assistant address yet (the MCP endpoint, FL-844). Until it
   * does (404), the setup steps are not offered: they would lead an assistant nowhere.
   */
  let assistantReady = $state(false);
  const checkAssistant = async () => {
    try {
      const response = await fetch(assistantAddress(''), { headers: { Accept: 'application/json' } });
      assistantReady = response.status !== 404;
    } catch {
      assistantReady = false;
    }
  };

  onMount(() => {
    void refresh();
    void checkAssistant();
  });

  /**
   * Remote access comes with a Frameleaf plan: then the assistant address is the published remote
   * one. Without it the server answers on the home network only, at the address this page uses.
   */
  const remoteUrl = $derived(
    featureFlagsManager.value.remoteAccess ? serverConfigManager.value.frameleaf?.publicUrl : null,
  );
  const homeOrigin = $derived(
    serverConfigManager.value.externalDomain || (typeof location === 'undefined' ? '' : location.origin),
  );
  const remote = $derived(!!remoteUrl);
  const address = $derived(assistantAddress(remoteUrl || homeOrigin));
  const blocked = $derived(!remote && WEB_ASSISTANTS.includes(client));
  const clientName = $derived(
    client === 'claude' ? 'Claude' : client === 'chatgpt' ? 'ChatGPT' : $t('frameleaf_apps_setup_local'),
  );

  const steps = $derived.by(() => {
    const allow = {
      title: $t('frameleaf_apps_setup_allow_title'),
      detail:
        client === 'local'
          ? $t('frameleaf_apps_setup_allow_body_local')
          : $t('frameleaf_apps_setup_allow_body', { values: { name: clientName } }),
    };
    if (client === 'claude') {
      return [
        { title: $t('frameleaf_apps_setup_claude_1_title'), detail: $t('frameleaf_apps_setup_claude_1_body') },
        { title: $t('frameleaf_apps_setup_claude_2_title'), detail: $t('frameleaf_apps_setup_claude_2_body') },
        allow,
        { title: $t('frameleaf_apps_setup_ask_title'), detail: $t('frameleaf_apps_setup_claude_4_body') },
      ];
    }
    if (client === 'chatgpt') {
      return [
        { title: $t('frameleaf_apps_setup_chatgpt_1_title'), detail: $t('frameleaf_apps_setup_chatgpt_1_body') },
        { title: $t('frameleaf_apps_setup_chatgpt_2_title'), detail: $t('frameleaf_apps_setup_chatgpt_2_body') },
        allow,
        { title: $t('frameleaf_apps_setup_ask_title'), detail: $t('frameleaf_apps_setup_chatgpt_4_body') },
      ];
    }
    return [
      { title: $t('frameleaf_apps_setup_local_1_title'), detail: $t('frameleaf_apps_setup_local_1_body') },
      { title: $t('frameleaf_apps_setup_local_2_title'), detail: $t('frameleaf_apps_setup_local_2_body') },
      allow,
    ];
  });

  const ICONS: Record<string, string> = {
    claude: mdiCreationOutline,
    chatgpt: mdiChatOutline,
    homeassistant: mdiHomeAutomation,
  };
  const iconOf = (grant: OAuthAppGrantDto) =>
    (grant.client.knownApp && ICONS[grant.client.knownApp]) || mdiApplicationOutline;
  const date = (iso: string) => DateTime.fromISO(iso, { locale: $locale }).toLocaleString(DateTime.DATE_MED);
  const usedText = (grant: OAuthAppGrantDto) => {
    const months = staleMonths(grant.lastUsedAt);
    if (months !== null) {
      return { tone: 'warn' as const, text: $t('frameleaf_apps_not_used_months', { values: { months } }) };
    }
    if (!grant.lastUsedAt) {
      return { tone: 'off' as const, text: $t('frameleaf_apps_not_used') };
    }
    const when = DateTime.fromISO(grant.lastUsedAt).toRelative({ locale: $locale }) ?? '';
    return { tone: 'good' as const, text: $t('frameleaf_apps_used', { values: { when } }) };
  };
  const fromText = (grant: OAuthAppGrantDto) =>
    grant.lastUsedVia === 'relay' || grant.lastUsedVia === 'direct'
      ? $t('frameleaf_apps_from_remote')
      : grant.lastUsedVia === 'home'
        ? $t('frameleaf_apps_from_home')
        : '';
  const noteOf = (grant: OAuthAppGrantDto) => {
    const from = fromText(grant);
    return from
      ? $t('frameleaf_apps_row_note', { values: { from, date: date(grant.createdAt) } })
      : $t('frameleaf_apps_row_note_allowed', { values: { date: date(grant.createdAt) } });
  };

  const stale = $derived(grants.find((grant) => staleMonths(grant.lastUsedAt) !== null));

  const open = (step: 'details' | 'remove', grant: OAuthAppGrantDto) => {
    showing = { step, grant };
    dialogOpen = true;
  };

  const remove = async (grant: OAuthAppGrantDto) => {
    working = true;
    try {
      await revokeOAuthAppGrant({ id: grant.id });
      grants = grants.filter((item) => item.id !== grant.id);
      dialogOpen = false;
      said = $t('frameleaf_apps_removed', { values: { name: grant.client.name } });
    } catch (error) {
      dialogOpen = false;
      // 404: the app was already removed (elsewhere); anything else is a real failure to report
      if (!(isHttpError(error) && error.status === 404)) {
        handleError(error, $t('frameleaf_apps_remove_failed', { values: { name: grant.client.name } }));
      }
      await refresh();
    } finally {
      working = false;
    }
  };

  const copyAddress = async () => {
    if (await copyToClipboard(address)) {
      said = $t('frameleaf_apps_setup_address_copied');
    }
  };

  const HA_GUIDE = 'https://frameleaf.app/docs/home-assistant';
  const toSetup = () =>
    document.querySelector('#connected-apps-setup')?.scrollIntoView({ behavior: motionScrollBehavior() });
</script>

{#snippet connectAction()}
  <Button variant="primary" onclick={toSetup}>{$t('frameleaf_apps_connect_assistant')}</Button>
{/snippet}
{#snippet retryAction()}
  <Button onclick={() => void refresh()}>{$t('frameleaf_apps_try_again')}</Button>
{/snippet}
{#snippet staleAction()}
  <Button variant="primary" onclick={() => stale && open('remove', stale)}
    >{$t('frameleaf_apps_remove_access_more')}</Button
  >
{/snippet}
{#snippet remoteAction()}
  <Button onclick={() => goto(commandCenterUrl('cloud', 'cloud-remote'))}
    >{$t('frameleaf_apps_setup_see_remote')}</Button
  >
{/snippet}

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />

  {#if load === 'loading'}
    <Hero
      tone="quiet"
      icon={mdiPuzzleOutline}
      title={$t('frameleaf_apps_hero_loading')}
      body={$t('frameleaf_apps_hero_loading_body')}
      label={$t('frameleaf_apps_title')}
    />
  {:else if load === 'error'}
    <Hero
      tone="warn"
      icon={mdiPuzzleOutline}
      title={$t('frameleaf_apps_hero_error')}
      body={$t('frameleaf_apps_hero_error_body')}
      label={$t('frameleaf_apps_title')}
      actions={retryAction}
    />
  {:else if grants.length === 0}
    <Hero
      tone="quiet"
      icon={mdiPuzzleOutline}
      title={$t('frameleaf_apps_hero_none')}
      body={$t('frameleaf_apps_hero_none_body')}
      label={$t('frameleaf_apps_title')}
      actions={assistantReady ? connectAction : undefined}
    />
  {:else if stale}
    <Hero
      tone="warn"
      icon={mdiPuzzleOutline}
      title={$t('frameleaf_apps_hero_stale', {
        values: { name: stale.client.name, months: staleMonths(stale.lastUsedAt) ?? 3 },
      })}
      body={$t('frameleaf_apps_hero_stale_body', { values: { count: grants.length, name: stale.client.name } })}
      label={$t('frameleaf_apps_title')}
      actions={staleAction}
    />
  {:else}
    <Hero
      tone="good"
      icon={mdiPuzzleCheckOutline}
      title={$t('frameleaf_apps_hero_count', { values: { count: grants.length } })}
      body={$t('frameleaf_apps_hero_count_body')}
      label={$t('frameleaf_apps_title')}
    />
  {/if}

  {#if load === 'ready' && grants.length > 0}
    <Section title={$t('frameleaf_apps_yours')} description={$t('frameleaf_apps_yours_description')}>
      <ItemList>
        {#each grants as grant (grant.id)}
          {@const used = usedText(grant)}
          <Item
            icon={iconOf(grant)}
            name={grant.client.name}
            detail={accessSummary($t, grant.scopes)}
            tone={used.tone}
            status={used.text}
            note={noteOf(grant)}
          >
            {#snippet action()}
              <div class="row-buttons">
                <Button
                  label={$t('frameleaf_apps_details_label', { values: { name: grant.client.name } })}
                  onclick={() => open('details', grant)}>{$t('frameleaf_apps_details')}</Button
                >
                <Button
                  label={$t('frameleaf_apps_remove_label', { values: { name: grant.client.name } })}
                  onclick={() => open('remove', grant)}
                  ><Icon icon={mdiLinkVariantOff} size="1.1em" aria-hidden />{$t('frameleaf_apps_remove')}</Button
                >
              </div>
            {/snippet}
          </Item>
        {/each}
      </ItemList>
    </Section>
  {/if}

  {#if assistantReady}
    <Section
      id="connected-apps-setup"
      title={$t('frameleaf_apps_setup_title')}
      description={$t('frameleaf_apps_setup_description')}
    >
      <div class="card">
        <div class="address">
          <span class="label">{$t('frameleaf_apps_setup_address')}</span>
          <div class="copy">
            <strong class="value">{address}</strong>
            <Button label={$t('frameleaf_apps_setup_address_copy')} onclick={copyAddress}
              ><Icon icon={mdiContentCopy} size="1.1em" aria-hidden />{$t('frameleaf_apps_copy')}</Button
            >
          </div>
          <p class="hint">
            {remote ? $t('frameleaf_apps_setup_address_remote') : $t('frameleaf_apps_setup_address_home')}
          </p>
        </div>
        {#if !remote}
          <Notice
            tone="warn"
            icon={mdiHomeOutline}
            title={$t('frameleaf_apps_setup_needs_remote_title')}
            action={remoteAction}
          >
            {$t('frameleaf_apps_setup_needs_remote_body')}
          </Notice>
        {/if}
        <div class="client">
          <span class="label">{$t('frameleaf_apps_setup_which')}</span>
          <SegmentedControl
            label={$t('frameleaf_apps_setup_which')}
            options={[
              { value: 'claude', label: 'Claude' },
              { value: 'chatgpt', label: 'ChatGPT' },
              { value: 'local', label: $t('frameleaf_apps_setup_local') },
            ]}
            value={client}
            onChange={(value: string) => (client = value as AssistantClient)}
          />
        </div>
        {#if blocked}
          <p class="blocked">
            <Icon icon={mdiLockOutline} size="18" aria-hidden />
            {$t('frameleaf_apps_setup_blocked', { values: { name: clientName } })}
          </p>
        {:else}
          <Steps {steps} stacked label={$t('frameleaf_apps_setup_title')} />
        {/if}
      </div>
      <Advanced>
        <p class="hint">{$t('frameleaf_apps_setup_advanced')}</p>
      </Advanced>
    </Section>
  {/if}

  <Section title={$t('frameleaf_apps_ha_title')} description={$t('frameleaf_apps_ha_description')}>
    <div class="card ha">
      <span class="tile" aria-hidden="true"><Icon icon={mdiHomeAutomation} size="22" /></span>
      <div>
        <strong>{$t('frameleaf_apps_ha_heading')}</strong>
        <p>{$t('frameleaf_apps_ha_body', { values: { address: homeOrigin } })}</p>
      </div>
      <Button onclick={() => window.open(HA_GUIDE, '_blank', 'noopener,noreferrer')}
        ><Icon icon={mdiOpenInNew} size="1.1em" aria-hidden />{$t('frameleaf_apps_ha_guide')}</Button
      >
    </div>
  </Section>
</KitPage>

{#if showing}
  {@const grant = showing.grant}
  {#if showing.step === 'details'}
    <Dialog title={grant.client.name} closeLabel={$t('close')} bind:open={dialogOpen}>
      <div class="dialog">
        <p>
          {grant.client.verified && grant.client.maker
            ? $t('frameleaf_apps_details_verified', { values: { maker: grant.client.maker } })
            : $t('frameleaf_apps_details_unverified')}
          {$t('frameleaf_apps_details_allowed', { values: { date: date(grant.createdAt) } })}
          {fromText(grant)}
        </p>
        <h3>{$t('frameleaf_apps_details_can')}</h3>
        <Points rows={plainAccess($t, grant.scopes).can.map((text) => ({ text }))} />
        <h3>{$t('frameleaf_apps_details_cant')}</h3>
        <Points rows={neverAllowed($t).map((text) => ({ text, not: true }))} />
      </div>
      {#snippet actions()}
        <Button onclick={() => open('remove', grant)}
          ><Icon icon={mdiLinkVariantOff} size="1.1em" aria-hidden />{$t('frameleaf_apps_remove_access_more')}</Button
        >
        <Button variant="primary" initialFocus onclick={() => (dialogOpen = false)}>{$t('frameleaf_apps_done')}</Button>
      {/snippet}
    </Dialog>
  {:else}
    <Dialog
      title={$t('frameleaf_apps_remove_title', { values: { name: grant.client.name } })}
      closeLabel={$t('close')}
      bind:open={dialogOpen}
    >
      <div class="dialog">
        <p>{$t('frameleaf_apps_remove_body', { values: { name: grant.client.name } })}</p>
        <p>{$t('frameleaf_apps_remove_body_again')}</p>
      </div>
      {#snippet actions()}
        <Button onclick={() => (dialogOpen = false)}>{$t('cancel')}</Button>
        <Button variant="danger" disabled={working} onclick={() => remove(grant)}
          >{$t('frameleaf_apps_remove_access')}</Button
        >
      {/snippet}
    </Dialog>
  {/if}
{/if}

<style>
  .row-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .card {
    display: grid;
    gap: var(--fl-space-5);
    padding: var(--fl-space-5);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .address {
    display: grid;
    gap: var(--fl-space-2);
  }
  .copy {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
  }
  .copy {
    flex-wrap: wrap;
  }
  .label {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .value {
    min-width: 0;
    font-size: var(--fl-font-callout);
    overflow-wrap: anywhere;
  }
  .client :global([role='group']) {
    justify-self: start;
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .client {
    display: grid;
    gap: var(--fl-space-3);
  }
  .blocked {
    font-size: var(--fl-font-small);
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-3);
    margin: 0;
    color: var(--fl-muted);
  }
  .blocked :global(svg) {
    flex: none;
    margin-top: 0.15em;
  }
  .ha {
    grid-template-columns: auto 1fr auto;
    align-items: center;
  }
  .ha strong {
    font-size: var(--fl-font-size);
  }
  .ha p {
    margin: var(--fl-space-1) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .tile {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-accent);
  }
  .dialog {
    display: grid;
    gap: var(--fl-space-3);
  }
  .dialog p,
  .dialog h3 {
    margin: 0;
  }
  .dialog h3 {
    margin-top: var(--fl-space-2);
    font-size: var(--fl-font-size);
  }
  @media (max-width: 640px) {
    .ha {
      grid-template-columns: auto 1fr;
    }
    .ha > :global(button) {
      grid-column: 1 / -1;
      justify-self: start;
    }
  }
</style>
