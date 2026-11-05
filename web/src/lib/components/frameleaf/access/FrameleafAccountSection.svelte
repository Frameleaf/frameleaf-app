<script lang="ts">
  /**
   * Your preferences → Frameleaf account (FL-158): the prototype's `FrameleafAccountLink`
   * (design/frameleaf/template/src/FrameleafCloud.jsx:2889-2980, effd05ffb7). Linking signs in on
   * Frameleaf and comes back to `/link`, which links the account and returns here; unlinking asks
   * first and ends this account's other Sign in with Frameleaf sessions. Signing in at home is
   * never affected.
   *
   * `view` draws the same link three ways: `form` (one line and a button, for "Set up your account"),
   * `page` (Your preferences › Frameleaf account: the prototype's `FrameleafAccount` in
   * `settings-v2/server/preferences.jsx`, a "Linked to…" hero and the "What linking does" facts) and
   * `row` (the Frameleaf account row of "How you sign in", `settings-v2/cloud/Personal.jsx` MySignIn).
   * The page around a row reads the state through `link` and links through `connect()`.
   */
  import { goto } from '$app/navigation';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { locale } from '$lib/stores/preferences.store';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight, mdiCloudCheckOutline, mdiCloudOffOutline, mdiCloudOutline } from '@mdi/js';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { startFrameleaf } from '$lib/frameleaf/frameleaf-sign-in';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    getFrameleafAccountLink,
    unlinkFrameleafAccount,
    type FrameleafAccountLinkResponseDto,
  } from '@frameleaf/sdk';
  import { toastManager } from '@frameleaf/ui';
  import { onDestroy, onMount } from 'svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { t } from 'svelte-i18n';
  import symbolUrl from '$lib/assets/frameleaf/frameleaf-symbol.svg?url';
  import './access.css';

  let alive = true;
  const isCurrentSession = authManager.captureSession();
  const isCurrent = () => alive && isCurrentSession();
  onDestroy(() => {
    alive = false;
  });

  let {
    view = 'form',
    link = $bindable(null),
  }: { view?: 'form' | 'row' | 'page'; link?: FrameleafAccountLinkResponseDto | null } = $props();

  let loadFailed = $state(false);
  let working = $state(false);
  let error = $state('');

  const load = async () => {
    if (!isCurrent()) {
      return;
    }
    loadFailed = false;
    try {
      const result = await getFrameleafAccountLink();
      if (isCurrent()) {
        link = result;
      }
    } catch {
      if (isCurrent()) {
        loadFailed = true;
      }
    }
  };

  onMount(load);

  const since = (value: string | null) =>
    value ? new Intl.DateTimeFormat($locale, { dateStyle: 'medium' }).format(new Date(value)) : '';

  export const connect = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_personal_link_title'),
      prompt: $t('frameleaf_personal_link_prompt'),
      confirmText: $t('frameleaf_personal_link_continue'),
    });
    if (!confirmed || !isCurrent()) {
      return;
    }
    working = true;
    error = '';
    try {
      await startFrameleaf('link', location, undefined, isCurrent);
    } catch (error_) {
      if (!isCurrent()) {
        return;
      }
      error = getServerErrorMessage(error_) ?? $t('frameleaf_personal_link_failed');
      working = false;
    }
  };

  const disconnect = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_personal_unlink_title'),
      prompt: $t('frameleaf_personal_unlink_prompt'),
      confirmText: $t('frameleaf_personal_unlink'),
      cancelText: $t('frameleaf_personal_keep_linked'),
      danger: true,
    });
    if (!confirmed || !isCurrent()) {
      return;
    }
    working = true;
    error = '';
    try {
      await unlinkFrameleafAccount();
      if (!isCurrent()) {
        return;
      }
      toastManager.primary($t('frameleaf_personal_unlinked'));
      await load();
    } catch (error_) {
      if (!isCurrent()) {
        return;
      }
      error = getServerErrorMessage(error_) ?? $t('frameleaf_personal_unlink_failed');
    } finally {
      if (isCurrent()) {
        working = false;
      }
    }
  };
</script>

{#if view === 'page'}
  <KitPage>
    {#if !link && loadFailed}
      <Hero
        tone="warn"
        icon={mdiCloudOffOutline}
        title={$t('frameleaf_personal_load_failed')}
        label={$t('frameleaf_personal_title')}
      >
        {#snippet actions()}
          <Button disabled={working} onclick={() => void load()}>{$t('frameleaf_personal_try_again')}</Button>
        {/snippet}
      </Hero>
    {:else if !link}
      <Hero
        tone="quiet"
        icon={mdiCloudOutline}
        title={$t('frameleaf_personal_loading')}
        label={$t('frameleaf_personal_title')}
      />
    {:else if link.linked}
      <Hero
        tone="good"
        icon={mdiCloudCheckOutline}
        title={$t('frameleaf_personal_hero_linked', { values: { email: link.email } })}
        body={link.linkedAt
          ? $t('frameleaf_personal_hero_linked_body', { values: { date: since(link.linkedAt) } })
          : $t('frameleaf_personal_hero_linked_body_undated')}
        label={$t('frameleaf_personal_title')}
      >
        {#snippet actions()}
          <Button disabled={working} onclick={disconnect}>{$t('frameleaf_personal_unlink_more')}</Button>
        {/snippet}
      </Hero>
    {:else if link.available}
      <Hero
        tone="quiet"
        icon={mdiCloudOutline}
        title={$t('frameleaf_personal_hero_not_linked')}
        body={$t('frameleaf_personal_hero_not_linked_body')}
        label={$t('frameleaf_personal_title')}
      >
        {#snippet actions()}
          <Button variant="primary" disabled={working} onclick={connect}>{$t('frameleaf_personal_link')}</Button>
        {/snippet}
      </Hero>
    {:else if authManager.user.isAdmin}
      <Hero
        tone="quiet"
        icon={mdiCloudOffOutline}
        title={$t('frameleaf_personal_hero_server_admin')}
        body={$t('frameleaf_personal_hero_server_admin_body')}
        label={$t('frameleaf_personal_title')}
      >
        {#snippet actions()}
          <Button variant="primary" onclick={() => goto(commandCenterUrl('cloud', 'cloud-account'))}
            >{$t('frameleaf_signin_link_server')}<Icon icon={mdiChevronRight} size="1em" aria-hidden /></Button
          >
        {/snippet}
      </Hero>
    {:else}
      <Hero
        tone="quiet"
        icon={mdiCloudOffOutline}
        title={$t('frameleaf_personal_hero_server')}
        body={$t('frameleaf_personal_server_not_linked')}
        label={$t('frameleaf_personal_title')}
      />
    {/if}
    {#if error}
      <Notice tone="warn" title={error} />
    {/if}
    <Section title={$t('frameleaf_personal_what_title')}>
      <Facts
        rows={[
          {
            label: $t('frameleaf_personal_fact_away'),
            value: link?.linked ? $t('frameleaf_personal_fact_away_yes') : $t('frameleaf_personal_fact_away_no'),
            detail: $t('frameleaf_personal_fact_away_detail'),
          },
          {
            label: $t('frameleaf_personal_fact_home'),
            value: $t('frameleaf_personal_fact_home_value'),
            detail: $t('frameleaf_personal_fact_home_detail'),
          },
          {
            label: $t('frameleaf_personal_fact_photos'),
            value: $t('frameleaf_personal_fact_photos_value'),
            detail: $t('frameleaf_personal_fact_photos_detail'),
          },
          {
            label: $t('frameleaf_personal_fact_cost'),
            value: $t('frameleaf_personal_fact_cost_value'),
            detail: $t('frameleaf_personal_fact_cost_detail'),
          },
        ]}
      />
    </Section>
  </KitPage>
{:else if view === 'row'}
  <Item
    icon={mdiCloudOutline}
    name={$t('frameleaf_personal_title')}
    detail={$t('frameleaf_how_frameleaf_detail')}
    off={!link?.linked}
    tone={error || (link && !link.linked && link.available) ? 'warn' : link?.linked ? 'good' : 'off'}
    status={!link
      ? loadFailed
        ? $t('frameleaf_how_unknown')
        : undefined
      : link.linked
        ? $t('frameleaf_how_linked')
        : link.available
          ? $t('frameleaf_how_not_linked')
          : $t('frameleaf_how_not_available')}
    note={error ||
      (!link
        ? loadFailed
          ? $t('frameleaf_personal_load_failed')
          : $t('frameleaf_personal_loading')
        : link.linked
          ? (link.email ?? undefined)
          : link.available
            ? $t('frameleaf_how_needed_away')
            : $t('frameleaf_how_server_not_linked'))}
  >
    {#snippet action()}
      {#if !link && loadFailed}
        <Button disabled={working} onclick={() => void load()}>{$t('frameleaf_personal_try_again')}</Button>
      {:else if link?.linked}
        <Button label={$t('frameleaf_how_unlink_label')} disabled={working} onclick={disconnect}
          >{$t('frameleaf_personal_unlink_more')}</Button
        >
      {:else if link?.available}
        <Button label={$t('frameleaf_how_link_label')} disabled={working} onclick={connect}
          >{$t('frameleaf_how_link')}</Button
        >
      {/if}
    {/snippet}
  </Item>
{:else}
  <!--
    "Set up your account" (prototype AccountSetup `pro-link`): the card around it says what linking does,
    so this is just the action, "Sign in with Frameleaf", with the state underneath only when it matters.
  -->
  <div class="fl-access-setup" aria-live="polite">
    {#if !link && loadFailed}
      <Button disabled={working} onclick={() => void load()}>{$t('frameleaf_personal_try_again')}</Button>
      <p>{$t('frameleaf_personal_load_failed')}</p>
    {:else if link?.linked}
      <p>{$t('frameleaf_personal_linked', { values: { email: link.email, date: since(link.linkedAt) } })}</p>
      <Button disabled={working} onclick={disconnect}>{$t('frameleaf_personal_unlink')}</Button>
    {:else}
      <Button disabled={working || !link?.available} onclick={connect}
        ><img class="fl-access-setup-mark" src={symbolUrl} alt="" />{$t('frameleaf_signin_label')}</Button
      >
      {#if link && !link.available}<p>{$t('frameleaf_personal_server_not_linked')}</p>{/if}
    {/if}
    {#if error}
      <p class="fl-access-error" role="alert">{error}</p>
    {/if}
  </div>
{/if}

<style>
  .fl-access-setup {
    display: grid;
    gap: var(--fl-space-2);
    justify-items: stretch;
  }
  .fl-access-setup p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fl-access-setup-mark {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }
</style>
