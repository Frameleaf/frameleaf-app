<script lang="ts">
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
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

<!-- A kit row of Sign-in & security: what it is and where it stands on the left, the one change on the right. -->
<div class="desktop-approval" role="group" aria-label={$t('frameleaf_desktop_approval_title')}>
  <Row
    label={$t('frameleaf_desktop_approval_title')}
    help={[
      $t('frameleaf_desktop_approval_description'),
      enabled === undefined
        ? ''
        : $t(enabled ? 'frameleaf_desktop_approval_enabled' : 'frameleaf_desktop_approval_disabled'),
    ]
      .filter(Boolean)
      .join(' ')}
  >
    {#if enabled !== undefined}
      <Button disabled={busy} onclick={change}
        >{$t(enabled ? 'frameleaf_desktop_approval_remove' : 'frameleaf_desktop_approval_allow')}</Button
      >
    {:else if failure}
      <Button onclick={() => reload++}>{$t('retry')}</Button>
    {:else}
      <span class="status" role="status">{$t('loading')}</span>
    {/if}
  </Row>
  {#if failure}<p class="failure" role="alert">{$t(failure)}</p>{/if}
</div>

<style>
  .status {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .failure {
    margin: 0 0 var(--fl-space-3);
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
</style>
