<script lang="ts">
  /**
   * "Text in this photo" in the information panel (FL-63), ported from `OcrSection` in
   * `design/frameleaf/template/src/MediaViewer.jsx`: the text read from the photo, a switch that
   * draws its regions over the photo, and Select text / Copy text.
   *
   * The owner also reviews the text here, which the prototype's sample data could not show: each line
   * can be corrected, dismissed or restored, and, when field suggestions are switched on, the dates,
   * totals and references the text suggests can be confirmed, corrected or dismissed. Every change is
   * a durable decision beside the recognized text, never an edit of it, and names the revision it read;
   * when the text or the decision moved on in the meantime the server refuses it and this section
   * reloads rather than overwriting. Hovering or focusing a line or a value draws its region.
   *
   * A suggested value is shown as what it is: read from the text, with the recognition confidence of
   * that text and where it is, and never as a verified record.
   *
   * Privacy: the section keeps nothing once the photo may no longer be read. A relock, a lost share or
   * a deleted photo makes the next read fail, and a failed read clears the text, the regions drawn over
   * the photo and any open edit. A late answer about a photo the viewer has already left is dropped.
   */
  import ViewerInlineEditError from '$lib/components/frameleaf/ViewerInlineEditError.svelte';
  import {
    DOCUMENT_REREAD_POLL_LIMIT,
    DOCUMENT_REREAD_POLL_MS,
    LatestRequest,
    confidenceLevel,
    confidencePercent,
    documentFieldLabelKey,
    documentFieldStatusKey,
    documentLineStatusKey,
    documentPlainText,
    isAbortError,
    isDecidedField,
    otherCandidates,
    overlayOverrides,
  } from '$lib/frameleaf/documents';
  import { classifyInlineEditError, type InlineEditFailure } from '$lib/frameleaf/inline-edit';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { ocrManager, type OcrRegion } from '$lib/stores/ocr.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetJobName,
    DocumentEditAction,
    DocumentFieldStatus,
    DocumentLineStatus,
    deleteDocumentField,
    deleteDocumentLine,
    getDocument,
    runAssetJobs,
    updateDocumentField,
    updateDocumentLine,
    type AssetResponseDto,
    type DocumentFieldCandidateDto,
    type DocumentFieldResponseDto,
    type DocumentLineDto,
    type DocumentResponseDto,
  } from '@immich/sdk';
  import { Badge, Button, Text, toastManager } from '@immich/ui';
  import {
    mdiCheck,
    mdiClose,
    mdiContentCopy,
    mdiEyeOffOutline,
    mdiMapMarkerOutline,
    mdiPencilOutline,
    mdiRefresh,
    mdiRestore,
    mdiSelectAll,
    mdiTextRecognition,
  } from '@mdi/js';
  import { onDestroy, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
  };

  let { asset }: Props = $props();

  type Editing = { kind: 'line'; id: string } | { kind: 'field'; field: DocumentFieldResponseDto['field'] };
  type CandidateChoice = Pick<DocumentFieldCandidateDto, 'value' | 'lineId'>;

  let shown = $state<DocumentResponseDto | null>(null);
  let loadFailure = $state<InlineEditFailure | null>(null);
  let actionFailure = $state<InlineEditFailure | null>(null);
  let editing = $state<Editing | null>(null);
  let draft = $state('');
  let busy = $state<string | null>(null);
  let rereadPending = $state(false);
  let pinned = $state<OcrRegion | null>(null);
  let textElement = $state<HTMLElement>();

  const request = new LatestRequest();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const lines = $derived(shown?.lines ?? []);
  const readable = $derived(documentPlainText(shown));
  const canEdit = $derived(shown?.canEdit ?? false);
  const fields = $derived(shown?.fieldsEnabled ? shown.fields : []);
  const recognition = $derived(shown?.recognition ?? null);
  const canReadAgain = $derived(!!recognition?.enabled && !!recognition?.routed);
  // someone else's photo shows only its readable text; the owner also reviews dismissed and kept lines
  const hasContent = $derived(canEdit ? lines.length > 0 : readable.length > 0);

  const stopPolling = () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
    rereadPending = false;
  };

  /** Nothing about a photo's text stays on screen once it may not be read. */
  const clearEvidence = () => {
    shown = null;
    editing = null;
    actionFailure = null;
    pinned = null;
    ocrManager.setDocumentText(null);
    ocrManager.setHighlight(null);
  };

  const apply = (next: DocumentResponseDto) => {
    shown = next;
    pinned = null;
    ocrManager.setHighlight(null);
    ocrManager.setDocumentText({ assetId: next.assetId, overrides: overlayOverrides(next) });
  };

  const load = async (assetId: string): Promise<DocumentResponseDto | undefined> => {
    const { signal, isCurrent } = request.start();
    try {
      const next = await getDocument({ id: assetId }, { signal });
      if (!isCurrent() || next.assetId !== asset.id) {
        return;
      }
      apply(next);
      loadFailure = null;
      return next;
    } catch (error) {
      if (!isCurrent() || isAbortError(error)) {
        return;
      }
      // relocked, no longer shared, trashed or deleted: the text goes with the access
      clearEvidence();
      loadFailure = classifyInlineEditError(error);
    }
  };

  let loadedAssetId = '';
  let loadedKey = '';
  let wasElevated = sessionAccess.isElevated;

  $effect(() => {
    const assetId = asset.id;
    const key = `${assetId}|${asset.updatedAt}|${sessionAccess.isElevated}`;
    const elevated = sessionAccess.isElevated;
    untrack(() => {
      if (key === loadedKey) {
        return;
      }
      const relocked = wasElevated && !elevated;
      wasElevated = elevated;
      loadedKey = key;
      if (assetId !== loadedAssetId || relocked) {
        loadedAssetId = assetId;
        stopPolling();
        clearEvidence();
        loadFailure = null;
      }
      if (authManager.isSharedLink) {
        request.cancel();
        return;
      }
      void load(assetId);
    });
  });

  onDestroy(() => {
    request.cancel();
    stopPolling();
    clearEvidence();
  });

  const point = (region: OcrRegion | null | undefined) => {
    if (region) {
      ocrManager.setHighlight(asset.id, region);
    }
  };

  const unpoint = () => ocrManager.setHighlight(pinned ? asset.id : null, pinned);

  const togglePin = (region: OcrRegion | null | undefined) => {
    pinned = region && pinned !== region ? region : null;
    ocrManager.setHighlight(pinned ? asset.id : null, pinned);
  };

  const mutate = async (key: string, action: () => Promise<DocumentResponseDto>) => {
    busy = key;
    actionFailure = null;
    // a read still on its way describes the text before this change; it must not land after it
    const { isCurrent } = request.start();
    try {
      const next = await action();
      if (isCurrent() && next.assetId === asset.id) {
        apply(next);
        editing = null;
      }
    } catch (error) {
      const failure = classifyInlineEditError(error);
      actionFailure = failure;
      if (failure === 'stale') {
        // the text or the decision moved on: show what is there now instead of replaying the change
        editing = null;
        await load(asset.id);
        toastManager.warning($t('frameleaf_documents_conflict'));
      } else if (failure === 'forbidden') {
        clearEvidence();
      }
    } finally {
      busy = null;
    }
  };

  const startEditingLine = (line: DocumentLineDto) => {
    editing = { kind: 'line', id: line.id };
    draft = line.text;
    actionFailure = null;
  };

  const startEditingField = (field: DocumentFieldResponseDto) => {
    editing = { kind: 'field', field: field.field };
    draft = field.value ?? '';
    actionFailure = null;
  };

  const cancelEditing = () => {
    editing = null;
    draft = '';
  };

  const saveLine = (line: DocumentLineDto) => {
    const value = draft.trim();
    if (!value || !line.ocrId || line.recognizedText === null) {
      return;
    }
    void mutate(`line:${line.id}`, () =>
      updateDocumentLine({
        id: asset.id,
        documentLineEditDto: {
          ocrId: line.ocrId!,
          recognizedText: line.recognizedText!,
          action: DocumentEditAction.Correct,
          value,
          revision: line.revision,
        },
      }),
    );
  };

  const dismissLine = (line: DocumentLineDto) => {
    if (!line.ocrId || line.recognizedText === null) {
      return;
    }
    void mutate(`line:${line.id}`, () =>
      updateDocumentLine({
        id: asset.id,
        documentLineEditDto: {
          ocrId: line.ocrId!,
          recognizedText: line.recognizedText!,
          action: DocumentEditAction.Dismiss,
          revision: line.revision,
        },
      }),
    );
  };

  const restoreLine = (line: DocumentLineDto) => {
    if (!line.editId || line.revision === null) {
      return;
    }
    void mutate(`line:${line.id}`, () =>
      deleteDocumentLine({ id: asset.id, editId: line.editId!, revision: line.revision! }),
    );
  };

  const confirmField = (field: DocumentFieldResponseDto, candidate: CandidateChoice) =>
    void mutate(`field:${field.field}`, () =>
      updateDocumentField({
        id: asset.id,
        field: field.field,
        documentFieldEditDto: {
          action: DocumentEditAction.Confirm,
          value: candidate.value,
          lineId: candidate.lineId,
          revision: field.revision,
        },
      }),
    );

  const saveField = (field: DocumentFieldResponseDto) => {
    const value = draft.trim();
    if (!value) {
      return;
    }
    void mutate(`field:${field.field}`, () =>
      updateDocumentField({
        id: asset.id,
        field: field.field,
        documentFieldEditDto: {
          action: DocumentEditAction.Correct,
          value,
          lineId: field.lineId,
          revision: field.revision,
        },
      }),
    );
  };

  const dismissField = (field: DocumentFieldResponseDto) =>
    void mutate(`field:${field.field}`, () =>
      updateDocumentField({
        id: asset.id,
        field: field.field,
        documentFieldEditDto: { action: DocumentEditAction.Dismiss, revision: field.revision },
      }),
    );

  const resetField = (field: DocumentFieldResponseDto) => {
    if (field.revision === null) {
      return;
    }
    void mutate(`field:${field.field}`, () =>
      deleteDocumentField({ id: asset.id, field: field.field, revision: field.revision! }),
    );
  };

  const onEditKeydown = (event: KeyboardEvent, save: () => void) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEditing();
    }
  };

  const selectText = () => {
    if (!textElement) {
      return;
    }
    try {
      const range = document.createRange();
      range.selectNodeContents(textElement);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } catch {
      // selection is a convenience; the text stays readable either way
    }
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(readable);
      toastManager.primary($t('frameleaf_documents_copied'));
    } catch {
      selectText();
      toastManager.info($t('frameleaf_documents_copy_fallback'));
    }
  };

  /** Waits for the new reading: the photo's text changes when the recognition job finishes. */
  const pollForReading = (assetId: string, before: string | null, attempt: number) => {
    rereadPending = true;
    pollTimer = setTimeout(
      () =>
        void (async () => {
          pollTimer = undefined;
          if (assetId !== asset.id) {
            rereadPending = false;
            return;
          }
          const next = await load(assetId);
          if (next && next.recognizedAt !== before) {
            rereadPending = false;
            // the boxes drawn over the photo come from the recognized text, which was just replaced
            assetCacheManager.invalidateAsset(assetId);
            await ocrManager.getAssetOcr(assetId);
            return;
          }
          if (attempt + 1 < DOCUMENT_REREAD_POLL_LIMIT) {
            pollForReading(assetId, before, attempt + 1);
          } else {
            rereadPending = false;
          }
        })(),
      DOCUMENT_REREAD_POLL_MS,
    );
  };

  const readAgain = async () => {
    const assetId = asset.id;
    const before = shown?.recognizedAt ?? null;
    busy = 'read-again';
    try {
      await runAssetJobs({ assetJobsDto: { assetIds: [assetId], name: AssetJobName.RefreshOcr } });
      toastManager.primary($t('frameleaf_documents_reading_again'));
      stopPolling();
      pollForReading(assetId, before, 0);
    } catch (error) {
      handleError(error, $t('frameleaf_documents_error_read_again'));
    } finally {
      busy = null;
    }
  };

  const lineBadgeColor = (line: DocumentLineDto) =>
    line.status === DocumentLineStatus.Recognized
      ? confidenceLevel(line.confidence) === 'low'
        ? 'warning'
        : 'secondary'
      : line.status === DocumentLineStatus.Dismissed
        ? 'secondary'
        : 'primary';

  const lineTextClass = (line: DocumentLineDto) =>
    line.status === DocumentLineStatus.Dismissed
      ? 'min-w-0 break-words line-through opacity-60'
      : 'min-w-0 break-words';

  const fieldValueClass = (field: DocumentFieldResponseDto) =>
    field.status === DocumentFieldStatus.Dismissed ? 'font-medium break-words opacity-60' : 'font-medium break-words';

  /** Kept apart from the markup so a long class list never decides how the template wraps. */
  const inputClass =
    'rounded-md border border-gray-300 bg-transparent px-2 py-1 text-sm text-black dark:border-gray-600 dark:text-white';

  const fieldBadgeColor = (field: DocumentFieldResponseDto) =>
    field.status === DocumentFieldStatus.Suggested
      ? confidenceLevel(field.confidence) === 'low'
        ? 'warning'
        : 'secondary'
      : 'primary';
</script>

{#if loadFailure === 'network' || loadFailure === 'unknown'}
  <section class="px-4 pt-4" data-testid="frameleaf-document-text-error">
    <ViewerInlineEditError failure={loadFailure} onRetry={() => void load(asset.id)} />
  </section>
{:else if shown && hasContent}
  <section class="px-4 pt-4 text-sm" data-testid="frameleaf-document-text">
    <div class="flex min-h-10 w-full flex-wrap items-center justify-between gap-2">
      <Text color="muted">{$t('frameleaf_documents_text_in_photo')}</Text>
      <Button
        size="small"
        color="secondary"
        variant="ghost"
        leadingIcon={mdiTextRecognition}
        aria-pressed={ocrManager.showOverlay}
        onclick={() => ocrManager.toggleOcrBoundingBox()}
      >
        {ocrManager.showOverlay ? $t('frameleaf_documents_hide_regions') : $t('frameleaf_documents_show_regions')}
      </Button>
    </div>

    <p
      class="rounded-md bg-gray-100 px-3 py-2 wrap-break-word whitespace-pre-wrap select-text dark:bg-gray-800"
      bind:this={textElement}
      data-testid="frameleaf-document-text-body"
    >
      {readable}
    </p>

    <div class="mt-2 flex flex-wrap gap-2">
      <Button size="small" color="secondary" variant="ghost" leadingIcon={mdiSelectAll} onclick={selectText}>
        {$t('frameleaf_documents_select_text')}
      </Button>
      <Button
        size="small"
        color="secondary"
        variant="ghost"
        leadingIcon={mdiContentCopy}
        onclick={() => void copyText()}
      >
        {$t('frameleaf_documents_copy_text')}
      </Button>
      {#if canEdit}
        <Button
          size="small"
          color="secondary"
          variant="ghost"
          leadingIcon={mdiRefresh}
          disabled={!canReadAgain || rereadPending}
          loading={busy === 'read-again' || rereadPending}
          onclick={() => void readAgain()}
        >
          {$t('frameleaf_documents_read_again')}
        </Button>
      {/if}
    </div>
    {#if canEdit && recognition && !canReadAgain}
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {#if !recognition.enabled}
          {$t('frameleaf_documents_read_again_disabled')}
        {:else if authManager.authenticated && authManager.user.isAdmin}
          {$t('frameleaf_documents_read_again_unrouted_admin')}
        {:else}
          {$t('frameleaf_documents_read_again_unrouted')}
        {/if}
      </p>
    {/if}

    {#if actionFailure && actionFailure !== 'stale'}
      <ViewerInlineEditError failure={actionFailure} onReload={() => void load(asset.id)} />
    {/if}

    {#if canEdit}
      <details class="mt-3" data-testid="frameleaf-document-lines">
        <summary class="cursor-pointer py-1 text-xs text-gray-500 dark:text-gray-400">
          {$t('frameleaf_documents_review_lines', { values: { count: lines.length } })}
        </summary>
        <ol class="mt-2 flex flex-col gap-2">
          {#each lines as line (line.id)}
            {@const isBusy = busy === `line:${line.id}`}
            <li
              class="rounded-md border border-gray-200 p-2 dark:border-gray-700"
              onpointerenter={() => point(line.region)}
              onpointerleave={unpoint}
              onfocusin={() => point(line.region)}
              onfocusout={unpoint}
            >
              {#if editing?.kind === 'line' && editing.id === line.id}
                <label class="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
                  {$t('frameleaf_documents_correction_label', { values: { text: line.recognizedText ?? line.text } })}
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    class={inputClass}
                    type="text"
                    maxlength="2000"
                    autofocus
                    bind:value={draft}
                    onkeydown={(event) => onEditKeydown(event, () => saveLine(line))}
                  />
                </label>
                <div class="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="small"
                    color="primary"
                    leadingIcon={mdiCheck}
                    disabled={!draft.trim()}
                    loading={isBusy}
                    onclick={() => saveLine(line)}
                  >
                    {$t('save')}
                  </Button>
                  <Button size="small" color="secondary" variant="ghost" leadingIcon={mdiClose} onclick={cancelEditing}>
                    {$t('cancel')}
                  </Button>
                </div>
              {:else}
                <div class="flex items-start justify-between gap-2">
                  <p class={lineTextClass(line)}>
                    {line.text}
                  </p>
                  <Badge size="small" shape="round" color={lineBadgeColor(line)}>
                    {$t(documentLineStatusKey(line.status))}
                  </Badge>
                </div>
                {#if line.status === DocumentLineStatus.Recognized && confidencePercent(line.confidence) !== null}
                  <p class="text-xs text-gray-500 dark:text-gray-400">
                    {$t('frameleaf_documents_confidence', { values: { percent: confidencePercent(line.confidence) } })}
                  </p>
                {/if}
                {#if line.evidenceChanged && line.recognizedText !== null}
                  <p class="text-xs text-gray-500 dark:text-gray-400">
                    {$t('frameleaf_documents_read_differently', { values: { text: line.recognizedText } })}
                  </p>
                {:else if line.status === DocumentLineStatus.Kept}
                  <p class="text-xs text-gray-500 dark:text-gray-400">{$t('frameleaf_documents_kept_note')}</p>
                {/if}
                <div class="mt-1 flex flex-wrap gap-1">
                  {#if line.status === DocumentLineStatus.Recognized || line.status === DocumentLineStatus.Corrected}
                    <Button
                      size="small"
                      color="secondary"
                      variant="ghost"
                      leadingIcon={mdiPencilOutline}
                      disabled={isBusy}
                      onclick={() => startEditingLine(line)}
                    >
                      {$t('frameleaf_documents_correct')}
                    </Button>
                    <Button
                      size="small"
                      color="secondary"
                      variant="ghost"
                      leadingIcon={mdiEyeOffOutline}
                      loading={isBusy}
                      onclick={() => dismissLine(line)}
                    >
                      {$t('frameleaf_documents_dismiss')}
                    </Button>
                  {/if}
                  {#if line.editId}
                    <Button
                      size="small"
                      color="secondary"
                      variant="ghost"
                      leadingIcon={mdiRestore}
                      loading={isBusy}
                      onclick={() => restoreLine(line)}
                    >
                      {line.status === DocumentLineStatus.Kept
                        ? $t('frameleaf_documents_remove_kept')
                        : $t('frameleaf_documents_restore')}
                    </Button>
                  {/if}
                  {#if line.region}
                    <Button
                      size="small"
                      color="secondary"
                      variant="ghost"
                      leadingIcon={mdiMapMarkerOutline}
                      aria-pressed={pinned === line.region}
                      onclick={() => togglePin(line.region)}
                    >
                      {$t('frameleaf_documents_show_where')}
                    </Button>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ol>
      </details>
    {/if}

    {#if fields.length > 0}
      <div class="mt-4" data-testid="frameleaf-document-fields">
        <Text color="muted">{$t('frameleaf_documents_fields')}</Text>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">{$t('frameleaf_documents_fields_note')}</p>
        <ul class="mt-2 flex flex-col gap-2">
          {#each fields as field (field.field)}
            {@const isBusy = busy === `field:${field.field}`}
            {@const others = otherCandidates(field)}
            <li
              class="rounded-md border border-gray-200 p-2 dark:border-gray-700"
              onpointerenter={() => point(field.region)}
              onpointerleave={unpoint}
              onfocusin={() => point(field.region)}
              onfocusout={unpoint}
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <p class="text-xs text-gray-500 dark:text-gray-400">{$t(documentFieldLabelKey(field.field))}</p>
                  {#if editing?.kind === 'field' && editing.field === field.field}
                    <input
                      class={`mt-1 w-full ${inputClass}`}
                      type="text"
                      maxlength="2000"
                      aria-label={$t('frameleaf_documents_field_value_label', {
                        values: { field: $t(documentFieldLabelKey(field.field)) },
                      })}
                      bind:value={draft}
                      onkeydown={(event) => onEditKeydown(event, () => saveField(field))}
                    />
                  {:else}
                    <p class={fieldValueClass(field)}>
                      {field.value ?? $t('frameleaf_documents_field_none')}
                    </p>
                  {/if}
                </div>
                <Badge size="small" shape="round" color={fieldBadgeColor(field)}>
                  {$t(documentFieldStatusKey(field.status))}
                </Badge>
              </div>

              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {#if field.status === DocumentFieldStatus.Suggested && confidencePercent(field.confidence) !== null}
                  {$t('frameleaf_documents_confidence', { values: { percent: confidencePercent(field.confidence) } })}
                {:else if field.status === DocumentFieldStatus.Suggested}
                  {$t('frameleaf_documents_from_your_correction')}
                {:else if field.status !== DocumentFieldStatus.Dismissed && !field.region}
                  {$t('frameleaf_documents_entered_by_you')}
                {/if}
                {#if field.evidenceChanged}
                  {$t('frameleaf_documents_evidence_changed')}
                {/if}
              </p>

              <div class="mt-1 flex flex-wrap gap-1">
                {#if editing?.kind === 'field' && editing.field === field.field}
                  <Button
                    size="small"
                    color="primary"
                    leadingIcon={mdiCheck}
                    disabled={!draft.trim()}
                    loading={isBusy}
                    onclick={() => saveField(field)}
                  >
                    {$t('save')}
                  </Button>
                  <Button size="small" color="secondary" variant="ghost" leadingIcon={mdiClose} onclick={cancelEditing}>
                    {$t('cancel')}
                  </Button>
                {:else}
                  {#if field.status === DocumentFieldStatus.Suggested && field.value && field.lineId}
                    <Button
                      size="small"
                      color="secondary"
                      variant="ghost"
                      leadingIcon={mdiCheck}
                      loading={isBusy}
                      onclick={() => confirmField(field, { value: field.value!, lineId: field.lineId! })}
                    >
                      {$t('frameleaf_documents_confirm')}
                    </Button>
                  {/if}
                  <Button
                    size="small"
                    color="secondary"
                    variant="ghost"
                    leadingIcon={mdiPencilOutline}
                    disabled={isBusy}
                    onclick={() => startEditingField(field)}
                  >
                    {$t('frameleaf_documents_correct')}
                  </Button>
                  {#if field.status !== DocumentFieldStatus.Dismissed}
                    <Button
                      size="small"
                      color="secondary"
                      variant="ghost"
                      leadingIcon={mdiEyeOffOutline}
                      loading={isBusy}
                      onclick={() => dismissField(field)}
                    >
                      {$t('frameleaf_documents_dismiss')}
                    </Button>
                  {/if}
                  {#if isDecidedField(field)}
                    <Button
                      size="small"
                      color="secondary"
                      variant="ghost"
                      leadingIcon={mdiRestore}
                      loading={isBusy}
                      onclick={() => resetField(field)}
                    >
                      {$t('frameleaf_documents_reset')}
                    </Button>
                  {/if}
                  {#if field.region}
                    <Button
                      size="small"
                      color="secondary"
                      variant="ghost"
                      leadingIcon={mdiMapMarkerOutline}
                      aria-pressed={pinned === field.region}
                      onclick={() => togglePin(field.region)}
                    >
                      {$t('frameleaf_documents_show_where')}
                    </Button>
                  {/if}
                {/if}
              </div>

              {#if others.length > 0 && !(editing?.kind === 'field' && editing.field === field.field)}
                <div class="mt-2 flex flex-wrap items-center gap-1 text-xs">
                  <span class="text-gray-500 dark:text-gray-400">{$t('frameleaf_documents_other_readings')}</span>
                  {#each others as candidate (`${candidate.lineId}:${candidate.value}`)}
                    <button
                      type="button"
                      class="rounded-full bg-gray-100 px-2 py-0.5 hover:bg-gray-200 disabled:opacity-60 dark:bg-gray-700 dark:hover:bg-gray-600"
                      disabled={isBusy}
                      title={$t('frameleaf_documents_use_value', { values: { value: candidate.value } })}
                      onpointerenter={() => point(candidate.region)}
                      onfocus={() => point(candidate.region)}
                      onclick={() => confirmField(field, candidate)}
                    >
                      {candidate.value}
                    </button>
                  {/each}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </section>
{/if}
