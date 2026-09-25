<script lang="ts">
  import Dialog from './Dialog.svelte';
  import SharedLinkForm from './SharedLinkForm.svelte';
  import { canSendCopies, sendCopiesWithFeedback, sendCopyPermitted } from '$lib/frameleaf/send-copy';
  import { SharedLinkType } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  /**
   * The share sheet for a set of items, from the prototype's `ShareSheet` (`SharedLinks.jsx`).
   *
   * Production offers the public-link path only. The prototype's "Share with people in this
   * library" tiles mark individual items as shared with a person, and no server contract exists for
   * that yet: the only per-person sharing the server has is partner sharing, which exposes a whole
   * library, so it must never sit behind a per-item share button (FL-83 audit).
   *
   * FL-35 / FL-54: "Send a copy…" sits beside Cancel as in the prototype (SharedLinks.jsx:477-482)
   * where the browser can share files. It hands copies of the originals to the native share sheet and
   * creates no link, so it stays separate from Frameleaf sharing.
   */
  let {
    open = $bindable(false),
    assetIds,
    onClosed,
  }: {
    open?: boolean;
    assetIds: string[];
    /** Called once the sheet and the link form it opened have both closed. */
    onClosed?: () => void;
  } = $props();

  let linkFormOpen = $state(false);

  let wasActive = false;
  $effect(() => {
    const active = open || linkFormOpen;
    if (active) {
      wasActive = true;
    } else if (wasActive) {
      wasActive = false;
      onClosed?.();
    }
  });

  const subject = $derived($t('frameleaf_sharing.individual_items', { values: { count: assetIds.length } }));
  const linkTarget = $derived({ type: SharedLinkType.Individual, assetIds, name: subject });

  const sendCopy = () => {
    open = false;
    void sendCopiesWithFeedback(assetIds);
  };

  const openLinkForm = () => {
    open = false;
    linkFormOpen = true;
  };
</script>

<Dialog title={$t('frameleaf_sharing.share_subject', { values: { subject } })} closeLabel={$t('close')} bind:open>
  <p class="ss-link-copy">{$t('frameleaf_sharing.link_option_description')}</p>
  <div class="ss-actions">
    {#if canSendCopies() && sendCopyPermitted()}
      <button type="button" onclick={sendCopy}>{$t('frameleaf_send_copy')}</button>
    {/if}
    <button type="button" onclick={() => (open = false)}>{$t('cancel')}</button>
    <button type="button" class="primary" onclick={openLinkForm}>{$t('frameleaf_sharing.create_public_link')}</button>
  </div>
</Dialog>

<SharedLinkForm bind:open={linkFormOpen} target={linkTarget} />

<style>
  .ss-link-copy {
    color: var(--fl-muted);
  }
  .ss-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .ss-actions button {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0 0.75rem;
  }
  .ss-actions button.primary {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    border-color: var(--fl-accent);
  }
</style>
