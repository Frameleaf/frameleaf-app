<script lang="ts">
  /**
   * FL-721 (spec §6.2): your Locked copy of a partner's item whose files the partner encrypted, when
   * it doesn't open for you yet. Advanced Security: "Type Taylor’s passphrase" opens the partner
   * variant of the passphrase prompt. PIN mode, before the partner next opens Locked: "Not ready yet",
   * a notice and no prompt.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PassphraseModal from '$lib/components/frameleaf/settings/security/locked-encryption/PassphraseModal.svelte';
  import { PartnerLockedEncryptionReason, type PartnerLockedEncryptionDto } from '@frameleaf/sdk';
  import { Icon, modalManager } from '@frameleaf/ui';
  import { mdiLockClock, mdiShieldKeyOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    lockedEncryption,
    ownerId,
    onOpened,
  }: { lockedEncryption: PartnerLockedEncryptionDto; ownerId?: string; onOpened: () => void } = $props();

  const name = $derived(lockedEncryption.ownerName);
  const needsPassphrase = $derived(
    lockedEncryption.reason === PartnerLockedEncryptionReason.OwnerPassphrase && !!ownerId,
  );

  const type = async () => {
    if (await modalManager.show(PassphraseModal, { kind: 'partner', ownerId, ownerName: name })) {
      onOpened();
    }
  };
</script>

<div class="le-partner" role="status">
  <span class="le-partner-icon" aria-hidden="true">
    <Icon icon={needsPassphrase ? mdiShieldKeyOutline : mdiLockClock} size="32" />
  </span>
  {#if needsPassphrase}
    <h2>{$t('frameleaf_le_partner_title', { values: { name } })}</h2>
    <p>{$t('frameleaf_le_partner_needs_body', { values: { name } })}</p>
    <Button variant="primary" onclick={() => void type()}>
      {$t('frameleaf_le_partner_type', { values: { name } })}
    </Button>
  {:else}
    <h2>{$t('frameleaf_le_partner_not_ready_title')}</h2>
    <p>{$t('frameleaf_le_partner_not_ready_body', { values: { name } })}</p>
  {/if}
</div>

<style>
  .le-partner {
    display: grid;
    justify-items: center;
    align-content: center;
    gap: var(--fl-space-3);
    height: 100%;
    max-width: 420px;
    margin: 0 auto;
    padding: var(--fl-space-6) var(--fl-space-4);
    color: #fff;
    text-align: center;
  }
  .le-partner-icon {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    background: rgb(255 255 255 / 12%);
    border-radius: 18px;
  }
  h2 {
    margin: 0;
    font-size: var(--fl-font-headline);
    font-weight: 600;
  }
  p {
    margin: 0;
    color: rgb(255 255 255 / 72%);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
</style>
