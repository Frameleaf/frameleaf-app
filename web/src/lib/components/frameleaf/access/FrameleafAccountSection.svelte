<script lang="ts">
  /**
   * Your preferences → Frameleaf account (FL-158): the prototype's `FrameleafAccountLink`
   * (design/frameleaf/template/src/FrameleafCloud.jsx:2889-2980, effd05ffb7). Linking signs in on
   * Frameleaf and comes back to `/link`, which links the account and returns here; unlinking asks
   * first and ends this account's other Sign in with Frameleaf sessions. Signing in at home is
   * never affected.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { startFrameleaf } from '$lib/frameleaf/frameleaf-sign-in';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { getFrameleafAccountLink, unlinkFrameleafAccount, type FrameleafAccountLinkResponseDto } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import './access.css';

  let link = $state<FrameleafAccountLinkResponseDto | null>(null);
  let loadFailed = $state(false);
  let working = $state(false);
  let error = $state('');

  const load = async () => {
    loadFailed = false;
    try {
      link = await getFrameleafAccountLink();
    } catch {
      loadFailed = true;
    }
  };

  onMount(load);

  const since = (value: string | null) =>
    value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : '';

  const connect = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_personal_link_title'),
      prompt: $t('frameleaf_personal_link_prompt'),
      confirmText: $t('frameleaf_personal_link_continue'),
    });
    if (!confirmed) {
      return;
    }
    working = true;
    error = '';
    try {
      await startFrameleaf('link', location);
    } catch (error_) {
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
    if (!confirmed) {
      return;
    }
    working = true;
    error = '';
    try {
      await unlinkFrameleafAccount();
      toastManager.primary($t('frameleaf_personal_unlinked'));
      await load();
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_personal_unlink_failed');
    } finally {
      working = false;
    }
  };
</script>

<section class="fl-access-section" aria-labelledby="fl-access-frameleaf">
  <div class="fl-access-head">
    <div>
      <h3 id="fl-access-frameleaf">{$t('frameleaf_personal_title')}</h3>
      <p>
        {#if !link && loadFailed}
          {$t('frameleaf_personal_load_failed')}
        {:else if !link}
          {$t('frameleaf_personal_loading')}
        {:else if link.linked}
          {$t('frameleaf_personal_linked', { values: { email: link.email, date: since(link.linkedAt) } })}
        {:else if link.available}
          {$t('frameleaf_personal_not_linked')}
        {:else}
          {$t('frameleaf_personal_server_not_linked')}
        {/if}
      </p>
    </div>
    {#if !link && loadFailed}
      <Button disabled={working} onclick={() => void load()}>{$t('frameleaf_personal_try_again')}</Button>
    {:else if link?.linked}
      <Button disabled={working} onclick={disconnect}>{$t('frameleaf_personal_unlink')}</Button>
    {:else}
      <Button disabled={working || !link?.available} onclick={connect}>{$t('frameleaf_personal_link')}</Button>
    {/if}
  </div>
  {#if error}
    <p class="fl-access-error" role="alert">{error}</p>
  {/if}
</section>
