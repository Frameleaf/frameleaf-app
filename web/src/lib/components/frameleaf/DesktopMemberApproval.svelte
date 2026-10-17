<script lang="ts">
  import { readDesktopMemberApproval, setDesktopMemberApproval } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';

  let { userId }: { userId: string } = $props();
  let enabled = $state<boolean | undefined>();
  let busy = $state(false);
  let failure = $state<'' | 'frameleaf_desktop_approval_read_failed' | 'frameleaf_desktop_approval_write_failed'>('');
  let reload = $state(0);
  let generation = 0;
  $effect(() => {
    generation++;
    const id = userId;
    void reload;
    let cancelled = false;
    enabled = undefined;
    failure = '';
    busy = false;
    readDesktopMemberApproval({ id })
      .then((result) => {
        if (!cancelled) {
          enabled = result.enabled;
        }
      })
      .catch(() => {
        if (!cancelled) {
          failure = 'frameleaf_desktop_approval_read_failed';
        }
      });
    return () => {
      cancelled = true;
    };
  });
  async function change() {
    if (enabled === undefined || busy) {
      return;
    }
    const id = userId;
    const current = generation;
    busy = true;
    failure = '';
    try {
      const result = await setDesktopMemberApproval({ id, desktopMemberApprovalDto: { enabled: !enabled } });
      if (userId === id && current === generation) {
        enabled = result.enabled;
      }
    } catch {
      if (userId === id && current === generation) {
        failure = 'frameleaf_desktop_approval_write_failed';
      }
    } finally {
      if (userId === id && current === generation) {
        busy = false;
      }
    }
  }
</script>

<section aria-label={$t('frameleaf_desktop_approval_title')}>
  <h3>{$t('frameleaf_desktop_approval_title')}</h3>
  <p>{$t('frameleaf_desktop_approval_description')}</p>
  {#if failure}<p role="alert">{$t(failure)}</p>{/if}
  {#if enabled !== undefined}
    <p>{$t(enabled ? 'frameleaf_desktop_approval_enabled' : 'frameleaf_desktop_approval_disabled')}</p>
    <Button disabled={busy} onclick={change}
      >{$t(enabled ? 'frameleaf_desktop_approval_remove' : 'frameleaf_desktop_approval_allow')}</Button
    >
  {:else if failure}
    <Button onclick={() => reload++}>{$t('retry')}</Button>
  {:else}
    <p role="status">{$t('loading')}</p>
  {/if}
</section>

<style>
  section {
    margin-top: 1.25rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--fl-border);
  }
  h3 {
    margin: 0 0 0.375rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  p {
    margin: 0.5rem 0;
    font-size: var(--fl-font-small);
  }
</style>
