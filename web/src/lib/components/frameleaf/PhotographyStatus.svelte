<script module lang="ts">
  /**
   * Shared wording for the photography workspace and the client gallery: one name per shoot stage,
   * shoot type, order state and photo state, and one customer sentence per failure. The server and
   * the request helpers speak in fixed codes; everything shown goes through
   * these keys so it can be translated. An unknown code falls back to the code itself.
   */
  import type { Shoot } from '$lib/frameleaf/photography/api';
  import { codeForStatus, PhotographyError, type PhotographyErrorCode } from '$lib/frameleaf/photography/errors';
  import type { Translations } from 'svelte-i18n';

  export const shootStageKeys: Record<Shoot['stage'], Translations> = {
    Imported: 'frameleaf_photography_stage_imported',
    Selected: 'frameleaf_photography_stage_selected',
    Edited: 'frameleaf_photography_stage_edited',
    Proofing: 'frameleaf_photography_stage_proofing',
    Delivered: 'frameleaf_photography_stage_delivered',
  };

  export const shootTypeKeys: Record<Shoot['type'], Translations> = {
    'Family portrait': 'frameleaf_photography_type_family',
    Wedding: 'frameleaf_photography_type_wedding',
    Portrait: 'frameleaf_photography_type_portrait',
    Editorial: 'frameleaf_photography_type_editorial',
    Commercial: 'frameleaf_photography_type_commercial',
    Event: 'frameleaf_photography_type_event',
    Personal: 'frameleaf_photography_type_personal',
  };

  /** The one name of each shoot section, used by the rail and by the section's own heading. */
  export const shootSectionKeys = {
    photos: 'frameleaf_photography_section_photos',
    intake: 'frameleaf_photography_section_intake',
    workflow: 'frameleaf_photography_section_workflow',
    orders: 'frameleaf_photography_section_orders',
    presentation: 'frameleaf_photography_section_presentation',
    publishing: 'frameleaf_photography_section_publishing',
  } as const satisfies Record<string, Translations>;

  const orderStatusKeys: Record<string, Translations> = {
    quoted: 'frameleaf_photography_order_quoted',
    accepted: 'frameleaf_photography_order_accepted',
    settled: 'frameleaf_photography_order_settled',
    free: 'frameleaf_photography_order_free',
    refunded: 'frameleaf_photography_order_refunded',
    cancelled: 'frameleaf_photography_order_cancelled',
  };
  const photoStateKeys: Record<string, Translations> = {
    imported: 'frameleaf_photography_photo_imported',
    selected: 'frameleaf_photography_photo_selected',
    'approval-requested': 'frameleaf_photography_photo_approval_requested',
    approved: 'frameleaf_photography_photo_approved',
    delivered: 'frameleaf_photography_photo_delivered',
  };
  const processingKeys: Record<string, Translations> = {
    ready: 'frameleaf_photography_processing_ready',
    pending: 'frameleaf_photography_processing_pending',
    failed: 'frameleaf_photography_processing_failed',
  };
  const publicationKeys: Record<string, Translations> = {
    queued: 'frameleaf_photography_publication_queued',
    rendering: 'frameleaf_photography_publication_rendering',
    ready: 'frameleaf_photography_publication_ready',
    failed: 'frameleaf_photography_publication_failed',
  };
  const receiptKeys: Record<string, Translations> = {
    accepted: 'frameleaf_photography_receipt_accepted',
    settle: 'frameleaf_photography_receipt_settle',
    refund: 'frameleaf_photography_receipt_refund',
    cancel: 'frameleaf_photography_receipt_cancel',
  };
  const exclusionKeys: Record<string, Translations> = {
    unavailable: 'frameleaf_photography_exclusion_unavailable',
  };

  export type PhotographyLabel = 'order' | 'photo' | 'processing' | 'publication' | 'receipt' | 'exclusion';
  const labelKeys: Record<PhotographyLabel, Record<string, Translations>> = {
    order: orderStatusKeys,
    photo: photoStateKeys,
    processing: processingKeys,
    publication: publicationKeys,
    receipt: receiptKeys,
    exclusion: exclusionKeys,
  };

  /** The translation key for a server code, or nothing for a code this page does not know. */
  export const photographyLabelKey = (kind: PhotographyLabel, code: string | null | undefined) =>
    code ? labelKeys[kind][code] : undefined;

  /** The sentence for each code the request helpers throw (lib/frameleaf/photography/errors.ts). */
  const errorKeys: Record<PhotographyErrorCode, Translations> = {
    settings_changed: 'frameleaf_photography_error_settings_changed',
    collection_changed: 'frameleaf_photography_error_collection_changed',
    access_ended: 'frameleaf_photography_error_access_ended',
    wait: 'frameleaf_photography_error_wait',
    logo_unavailable: 'frameleaf_photography_error_logo',
    not_ready: 'frameleaf_photography_error_not_ready',
    watermark_preview: 'frameleaf_photography_error_watermark_preview',
    request_failed: 'frameleaf_photography_error_generic',
  };

  /** What to tell the person when a photography request fails. Never the raw response. */
  export const photographyErrorKey = (cause: unknown): Translations => {
    if (cause instanceof PhotographyError) {
      return errorKeys[cause.code];
    }
    // Anything else (a network failure, or an error from outside the helpers) is read by status.
    const status = (cause as { status?: number } | null)?.status;
    return typeof status === 'number' ? errorKeys[codeForStatus(status)] : 'frameleaf_photography_error_generic';
  };
</script>

<script lang="ts">
  /**
   * The quiet save status beside a title or a count: "Saving…", then "Saved" with a tick, or a
   * failure with a way to try again. Announced politely; the caller passes translated text.
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiCheck } from '@mdi/js';

  let {
    state,
    savingLabel,
    savedLabel,
    errorLabel = '',
    retryLabel = '',
    onRetry,
  }: {
    state: 'idle' | 'saving' | 'saved' | 'error';
    savingLabel: string;
    savedLabel: string;
    errorLabel?: string;
    retryLabel?: string;
    onRetry?: () => void;
  } = $props();
</script>

<span class="phs" data-state={state} role="status">
  {#if state === 'saving'}
    {savingLabel}
  {:else if state === 'saved'}
    <Icon icon={mdiCheck} size="14" aria-hidden={true} />{savedLabel}
  {:else if state === 'error'}
    <Icon icon={mdiAlertCircleOutline} size="14" aria-hidden={true} />{errorLabel}
    {#if onRetry}<button type="button" class="phs-retry" onclick={onRetry}>{retryLabel}</button>{/if}
  {/if}
</span>

<style>
  .phs {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 1.4em;
    font-size: var(--fl-font-small);
    opacity: 0.8;
  }
  .phs[data-state='saved'] {
    animation: phs-in var(--fl-motion) var(--fl-ease) both;
  }
  .phs[data-state='error'] {
    opacity: 1;
  }
  .phs-retry {
    min-height: 44px;
    padding: 0 8px;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  @keyframes phs-in {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .phs[data-state='saved'] {
      animation: none;
    }
  }
</style>
