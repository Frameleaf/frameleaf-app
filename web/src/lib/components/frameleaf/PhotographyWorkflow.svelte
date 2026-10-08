<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { AssetMediaSize, getAssetDevelop } from '@frameleaf/sdk';
  import Button from './Button.svelte';
  import PhotographyWatermarkEditor from './PhotographyWatermarkEditor.svelte';
  import {
    photographyErrorKey,
    photographyLabelKey,
    shootSectionKeys,
    shootTypeKeys,
    type PhotographyLabel,
  } from './PhotographyStatus.svelte';
  import { loadBrand, type Shoot, type Branding } from '$lib/frameleaf/photography/api';
  import {
    workflowRequest,
    studioPresetsRequest,
    type Workflow,
    type Capture,
    type Order,
    type OutputDefinition,
    type PresentationBlock,
  } from '$lib/frameleaf/photography/workflow-api';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { getAssetMediaUrl } from '$lib/utils';
  import { Route } from '$lib/route';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';

  let {
    shoot,
    panel = 'intake',
  }: { shoot: Shoot; panel?: 'intake' | 'workflow' | 'orders' | 'presentation' | 'publishing' } = $props();
  let stored = $state<Workflow | null>(null);
  let draft = $state<Workflow | null>(null);
  let brand = $state<Branding | null>(null);
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  let filter = $state('all');
  let query = $state('');
  let limit = $state(80);
  let selected = $state<string[]>([]);
  let ordering = $state<'chronological' | 'photographer' | 'manual' | 'chapters'>('chronological');
  let restrictInvitation = $state(false);
  let teamName = $state('');
  let clockOffset = $state(0);
  let applyCredit = $state(false);
  let applyClock = $state(false);
  let assemblyChapter = $state('__unchanged');
  let presetName = $state('');
  let recipientName = $state(shoot.client);
  let recipientPassword = $state('');
  let recipientExpiry = $state('');
  let recipientDownload = $state(false);
  let invitation = $state('');
  let paymentReference = $state('');
  let versionChoices = $state<Record<string, { id: string; label: string }[]>>({});
  let pinnedChoices = $state<Record<string, string>>({});
  let outputVersions = $state<Record<string, Record<string, string>>>({});
  let clientApproval = $state(true);
  let requestGeneration = 0;
  let disposed = false;
  const eligible = $derived(draft?.captures.filter((capture) => capture.eligible && !capture.withheld) ?? []);
  const filtered = $derived(
    (draft?.captures ?? []).filter(
      (capture) =>
        `${capture.number} ${capture.fileName} ${capture.camera ?? ''} ${capture.photographer}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (filter === 'all' ||
          (filter === 'raw' && capture.isRaw) ||
          (filter === 'rated' && (capture.rating ?? 0) >= 4) ||
          (filter === 'rejected' && capture.rating === -1) ||
          (filter === 'editing' &&
            stored?.orders.some(
              (order) =>
                !order.editingBlocked && order.items.some((item) => item.captureId === capture.id && !item.approved),
            )) ||
          (filter === 'delivery' &&
            stored?.orders.some((order) => order.items.some((item) => item.captureId === capture.id && item.ready))) ||
          (filter === 'issues' && (!capture.eligible || capture.processing === 'failed')) ||
          (filter === 'withheld' && capture.withheld) ||
          (filter === 'chosen' && stored?.rounds.some((round) => round.captureIds.includes(capture.id)))),
    ),
  );
  const money = (amount: number, currency = draft?.config.currency ?? 'USD') => {
    try {
      return new Intl.NumberFormat($locale, { style: 'currency', currency }).format(amount / 100);
    } catch {
      return `${amount / 100} ${currency}`;
    }
  };
  const photoUrl = (capture: Capture) =>
    capture.eligible && capture.assetId
      ? getAssetMediaUrl({ id: capture.assetId, size: AssetMediaSize.Thumbnail })
      : '';
  const describe = (cause: unknown) => $t(photographyErrorKey(cause));
  /** A server code in words, or the code itself when this page does not know it. */
  const named = (kind: PhotographyLabel, code: string | null | undefined) => {
    const key = photographyLabelKey(kind, code);
    return key ? $t(key) : (code ?? '');
  };
  const photoLabel = (number: number | string) => $t('frameleaf_photography_photo_number', { values: { number } });
  const blockTypeLabel = (type: PresentationBlock['type']) =>
    type === 'chapter'
      ? $t('frameleaf_photography_block_chapter')
      : type === 'grid'
        ? $t('frameleaf_photography_block_grid')
        : type === 'full'
          ? $t('frameleaf_photography_block_full')
          : type === 'pair'
            ? $t('frameleaf_photography_block_pair')
            : type === 'caption'
              ? $t('frameleaf_photography_block_caption')
              : $t('frameleaf_photography_block_slideshow');
  function orderOutputs(captureIds: string[]) {
    return draft?.config.downloadOutputs?.map((output) => ({
      ...$state.snapshot(output),
      revisions: captureIds.flatMap((captureId) => {
        const revisionId = outputVersions[output.key]?.[captureId];
        return revisionId ? [{ captureId, revisionId }] : [];
      }),
    }));
  }
  function addOutput(kind: OutputDefinition['kind']) {
    if (!draft) {
      return;
    }
    draft.config.downloadOutputs ??= [
      {
        key: 'print',
        label: $t('frameleaf_photography_full_resolution'),
        kind: 'print',
        maxEdge: 65_535,
        watermark: $state.snapshot(draft.config.downloadWatermark),
      },
    ];
    if (draft.config.downloadOutputs.length >= 6) {
      return;
    }
    draft.config.downloadOutputs.push({
      key: `${kind}-${crypto.randomUUID().slice(0, 8)}`,
      label:
        kind === 'print'
          ? $t('frameleaf_photography_output_print')
          : kind === 'web'
            ? $t('frameleaf_photography_output_web')
            : $t('frameleaf_photography_output_social'),
      kind,
      maxEdge: kind === 'print' ? 65_535 : kind === 'web' ? 2560 : 2048,
      watermark: null,
    });
  }
  function addBlock(type: PresentationBlock['type']) {
    if (!draft) {
      return;
    }
    draft.config.presentation.blocks ??= [];
    if (draft.config.presentation.blocks.length >= 100) {
      return;
    }
    draft.config.presentation.blocks.push({
      id: crypto.randomUUID(),
      type,
      chapterId: null,
      selection: 'automatic',
      captureIds: [],
      text: '',
    });
  }
  function moveBlock(index: number, direction: number) {
    const blocks = draft?.config.presentation.blocks;
    const next = index + direction;
    if (!blocks || next < 0 || next >= blocks.length) {
      return;
    }
    const block = blocks[index];
    blocks[index] = blocks[next];
    blocks[next] = block;
  }
  function moveBlockPhoto(block: PresentationBlock, index: number, direction: number) {
    const next = index + direction;
    if (next < 0 || next >= block.captureIds.length) {
      return;
    }
    const id = block.captureIds[index];
    block.captureIds[index] = block.captureIds[next];
    block.captureIds[next] = id;
  }
  async function saveStudioPreset(id: string | null = null) {
    if (!stored || !draft || busy || !presetName.trim()) {
      return;
    }
    busy = true;
    error = '';
    const current = ++requestGeneration;
    try {
      const result = await studioPresetsRequest('POST', {
        expectedRevision: draft.studioPresets?.revision ?? null,
        id,
        name: presetName.trim(),
        config: $state.snapshot(draft.config),
      });
      if (disposed || current !== requestGeneration) {
        return;
      }
      draft.studioPresets = result;
      stored.studioPresets = result;
      message = $t('frameleaf_photography_preset_saved');
    } catch (error_) {
      if (!disposed && current === requestGeneration) {
        error = describe(error_);
      }
    } finally {
      if (!disposed && current === requestGeneration) {
        busy = false;
      }
    }
  }
  function applyAssembly() {
    if (!draft) {
      return;
    }
    for (const capture of draft.captures) {
      if (!selected.includes(capture.id) || !capture.eligible) {
        continue;
      }
      if (applyCredit) {
        capture.photographer = teamName;
      }
      if (applyClock) {
        capture.offsetSeconds = clockOffset;
      }
      if (assemblyChapter !== '__unchanged') {
        capture.chapterId = assemblyChapter || null;
      }
    }
  }

  async function reload() {
    const current = ++requestGeneration;
    busy = true;
    error = '';
    invitation = '';
    try {
      const [workflow, branding] = await Promise.all([workflowRequest<Workflow>(shoot.id), loadBrand()]);
      if (disposed || current !== requestGeneration) {
        return;
      }
      stored = workflow;
      ordering = workflow.ordering;
      draft = structuredClone(workflow);
      brand = branding;
      selected = selected.filter((id) => workflow.captures.some((capture) => capture.id === id && capture.eligible));
    } catch (error_) {
      if (current === requestGeneration) {
        error = describe(error_);
      }
    } finally {
      if (current === requestGeneration) {
        busy = false;
      }
    }
  }
  async function mutate(path: string, method = 'POST', body: Record<string, unknown> = {}) {
    if (busy || !stored) {
      return;
    }
    const current = ++requestGeneration;
    busy = true;
    error = '';
    message = '';
    try {
      const result = await workflowRequest<
        Workflow | { workflow: Workflow; invitation: { recipientId: string; token: string } }
      >(shoot.id, path, method, { expectedRevision: stored.revision, ...body });
      if (disposed || current !== requestGeneration) {
        return;
      }
      const saved = 'workflow' in result ? result.workflow : result;
      stored = saved;
      draft = structuredClone(saved);
      if ('invitation' in result) {
        const url = new URL(
          `/photography/gallery/${shoot.id}`,
          serverConfigManager.value.externalDomain || location.origin,
        );
        url.hash = new URLSearchParams({ invitation: result.invitation.token }).toString();
        invitation = url.href;
        recipientPassword = '';
      }
      message = $t('frameleaf_photography_saved_short');
    } catch (error_) {
      if (current === requestGeneration) {
        error = describe(error_);
      }
    } finally {
      if (current === requestGeneration) {
        busy = false;
      }
    }
  }
  async function intake(directory = false) {
    if (!shoot.albumId || busy) {
      return;
    }
    busy = true;
    error = '';
    try {
      await openFileUploadDialog({ albumId: shoot.albumId, directory });
      if (disposed) {
        return;
      }
      busy = false;
      await mutate('/intake');
    } catch (error_) {
      if (!disposed) {
        error = describe(error_);
        busy = false;
      }
    }
  }
  function assemble() {
    if (!draft) {
      return;
    }
    void mutate('/assembly', 'PUT', {
      ordering,
      chapters: draft.chapters,
      captures: draft.captures.map(({ id, chapterId, position, offsetSeconds, photographer, withheld }) => ({
        id,
        chapterId,
        position,
        offsetSeconds,
        photographer,
        withheld,
      })),
    });
  }
  function addChapter() {
    if (!draft) {
      return;
    }
    draft.chapters.push({
      id: crypto.randomUUID(),
      title: $t('frameleaf_photography_chapter_default', { values: { number: draft.chapters.length + 1 } }),
      description: '',
      position: draft.chapters.length,
      coverCaptureId: null,
    });
  }
  function move(id: string, direction: number) {
    if (!draft) {
      return;
    }
    const rows = [...draft.captures].sort((a, b) => a.position - b.position);
    const index = rows.findIndex((row) => row.id === id);
    const adjacent = rows.at(index + direction);
    if (!adjacent || index + direction < 0) {
      return;
    }
    const item = rows[index];
    rows[index] = adjacent;
    rows[index + direction] = item;
    for (const [position, row] of rows.entries()) {
      row.position = position;
    }
    draft.captures = rows;
    ordering = 'manual';
  }
  async function revisions(capture: Capture) {
    if (!capture.eligible || !capture.assetId) {
      return;
    }
    error = '';
    try {
      const result = await getAssetDevelop({ id: capture.assetId });
      if (disposed) {
        return;
      }
      versionChoices[capture.id] = result.revisions
        .filter((revision) => revision.status === 'rendered' && revision.hasMaster)
        .map((revision) => ({
          id: revision.id,
          label:
            revision.label || $t('frameleaf_photography_version_number', { values: { number: revision.revision } }),
        }));
      pinnedChoices[capture.id] = capture.approvedRevisionId ?? versionChoices[capture.id][0]?.id ?? '';
    } catch (error_) {
      if (!disposed) {
        error = describe(error_);
      }
    }
  }
  function csv() {
    if (!stored) {
      return;
    }
    const escape = (value: unknown) => {
      const text = String(value ?? '');
      return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
    };
    const rows = [
      [
        $t('frameleaf_photography_csv_photo'),
        $t('frameleaf_photography_csv_file'),
        $t('frameleaf_photography_csv_camera'),
        $t('frameleaf_photography_photographer'),
        $t('frameleaf_photography_block_chapter'),
        $t('frameleaf_photography_filter_selected'),
        $t('frameleaf_photography_csv_approved_version'),
      ],
      ...stored.captures
        .filter((capture) => capture.eligible)
        .map((capture) => [
          capture.number,
          capture.fileName,
          capture.camera,
          capture.photographer,
          stored?.chapters.find((chapter) => chapter.id === capture.chapterId)?.title,
          stored?.rounds.some((round) => round.captureIds.includes(capture.id)),
          capture.approvedRevisionId,
        ]),
    ];
    const url = URL.createObjectURL(
      new Blob(['\u{FEFF}' + rows.map((row) => row.map((value) => escape(value)).join(',')).join('\r\n')], {
        type: 'text/csv;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'photography-selections.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copyInvitation() {
    try {
      await navigator.clipboard.writeText(invitation);
      message = $t('frameleaf_photography_invitation_copied');
    } catch {
      error = $t('frameleaf_photography_invitation_copy_failed');
    }
  }
  const recipient = (id: string) =>
    stored?.recipients.find((row) => row.id === id)?.name ?? $t('frameleaf_photography_recipient');
  const canSettle = (order: Order) => order.status === 'accepted';
  onMount(() => {
    void reload();
  });
  onDestroy(() => {
    disposed = true;
    requestGeneration++;
    invitation = '';
    recipientPassword = '';
  });
</script>

<div class="phd" aria-busy={busy}>
  <div class="phd-toolbar">
    <div>
      <span class="phd-eyebrow">{$t(shootTypeKeys[shoot.type])} · {shoot.client}</span>
      <h2>{$t(shootSectionKeys[panel])}</h2>
    </div>
    <Button disabled={busy} onclick={reload}>{$t('frameleaf_photography_refresh')}</Button>
  </div>
  {#if error}<div class="phw-notice" role="alert">
      {error}<Button disabled={busy} onclick={reload}>{$t('frameleaf_photography_reload')}</Button>
    </div>{/if}
  {#if message}<p class="phd-status" role="status">{message}</p>{/if}
  {#if !draft}<div class="phw-empty" role="status">
      {busy ? $t('frameleaf_photography_loading_shoot') : $t('frameleaf_photography_shoot_load_failed')}
    </div>
  {:else if shoot.unavailable}<div class="phw-empty">
      {$t('frameleaf_photography_album_unavailable_short')}
    </div>
  {:else}
    <div class="phd-metrics">
      <div><strong>{draft.captures.length}</strong><span>{$t('frameleaf_photography_metric_captures')}</span></div>
      <div><strong>{eligible.length}</strong><span>{$t('frameleaf_photography_metric_proofs')}</span></div>
      <div><strong>{draft.rounds.length}</strong><span>{$t('frameleaf_photography_selection_rounds')}</span></div>
      <div>
        <strong>{draft.orders.filter((order) => order.status === 'settled').length}</strong><span
          >{$t('frameleaf_photography_metric_paid')}</span
        >
      </div>
    </div>
    {#if panel === 'intake'}
      <section class="phd-card">
        <div class="phd-row">
          <div>
            <h3>{$t('frameleaf_photography_intake_title')}</h3>
            <p>
              {$t('frameleaf_photography_intake_body')}
            </p>
          </div>
          <div class="phd-actions">
            <Button disabled={busy || !shoot.albumId} onclick={() => intake()}
              >{$t('frameleaf_photography_import_files')}</Button
            ><Button disabled={busy || !shoot.albumId} onclick={() => intake(true)}
              >{$t('frameleaf_photography_import_folder')}</Button
            ><Button variant="primary" disabled={busy} onclick={() => mutate('/intake')}
              >{$t('frameleaf_photography_scan_album')}</Button
            >
          </div>
        </div>
      </section>
      <section class="phd-card">
        <div class="phd-row">
          <div>
            <h3>{$t('frameleaf_photography_chapters_title')}</h3>
            <p>{$t('frameleaf_photography_chapters_body')}</p>
          </div>
          <Button disabled={busy} onclick={addChapter}>{$t('frameleaf_photography_add_chapter')}</Button>
        </div>
        {#each draft.chapters as chapter (chapter.id)}<div class="phd-chapter">
            <label>{$t('frameleaf_photography_chapter_name')}<input maxlength="100" bind:value={chapter.title} /></label
            ><label
              >{$t('frameleaf_photography_description')}<input
                maxlength="1000"
                bind:value={chapter.description}
              /></label
            ><label
              >{$t('frameleaf_photography_cover')}<select bind:value={chapter.coverCaptureId}
                ><option value={null}>{$t('frameleaf_photography_automatic')}</option
                >{#each eligible as capture (capture.id)}<option value={capture.id}>{photoLabel(capture.number)}</option
                  >{/each}</select
              ></label
            ><label
              >{$t('frameleaf_photography_order')}<input
                type="number"
                min="0"
                step="1"
                bind:value={chapter.position}
              /></label
            >
          </div>{/each}
        <div class="phd-row">
          <label
            >{$t('frameleaf_photography_sequence')}<select bind:value={ordering}
              ><option value="chronological">{$t('frameleaf_photography_sequence_time')}</option><option
                value="photographer">{$t('frameleaf_photography_photographer')}</option
              ><option value="manual">{$t('frameleaf_photography_sequence_manual')}</option><option value="chapters"
                >{$t('frameleaf_photography_chapters')}</option
              ></select
            ></label
          ><Button variant="primary" disabled={busy} onclick={assemble}
            >{$t('frameleaf_photography_save_assembly')}</Button
          >
        </div>
      </section>
      <div class="phd-row">
        <label
          >{$t('frameleaf_photography_find_capture')}<input
            placeholder={$t('frameleaf_photography_find_capture_placeholder')}
            bind:value={query}
          /></label
        ><label
          >{$t('frameleaf_photography_show')}<select bind:value={filter}
            ><option value="all">{$t('frameleaf_photography_captures_all')}</option><option value="raw">RAW</option
            ><option value="rated">{$t('frameleaf_photography_captures_rated')}</option><option value="rejected"
              >{$t('frameleaf_photography_stat_rejected')}</option
            ><option value="editing">{$t('frameleaf_photography_captures_editing')}</option><option value="delivery"
              >{$t('frameleaf_photography_captures_delivery')}</option
            ><option value="chosen">{$t('frameleaf_photography_captures_chosen')}</option><option value="issues"
              >{$t('frameleaf_photography_captures_issues')}</option
            ><option value="withheld">{$t('frameleaf_photography_captures_withheld')}</option></select
          ></label
        ><span>{$t('frameleaf_photography_capture_count', { values: { count: filtered.length } })}</span>
      </div>
      <div class="phd-card">
        <h3>{$t('frameleaf_photography_assemble_title')}</h3>
        <p>{$t('frameleaf_photography_assemble_body')}</p>
        <div class="phd-fields">
          <label
            ><input type="checkbox" bind:checked={applyCredit} />{$t('frameleaf_photography_set_credit')}<input
              maxlength="100"
              disabled={!applyCredit}
              bind:value={teamName}
            /></label
          >
          <label
            ><input type="checkbox" bind:checked={applyClock} />{$t('frameleaf_photography_correct_clock')}<input
              type="number"
              min="-86400"
              max="86400"
              step="1"
              disabled={!applyClock}
              bind:value={clockOffset}
            /></label
          >
          <label
            >{$t('frameleaf_photography_block_chapter')}<select bind:value={assemblyChapter}
              ><option value="__unchanged">{$t('frameleaf_photography_keep_chapters')}</option><option value=""
                >{$t('frameleaf_photography_unassigned')}</option
              >{#each draft.chapters as chapter (chapter.id)}<option value={chapter.id}>{chapter.title}</option
                >{/each}</select
            ></label
          >
        </div>
        <div class="phd-actions">
          <Button
            disabled={busy}
            onclick={() => {
              selected = filtered.filter((capture) => capture.eligible).map((capture) => capture.id);
            }}>{$t('frameleaf_photography_select_in_view')}</Button
          ><Button
            disabled={busy || selected.length === 0}
            onclick={() => {
              selected = [];
            }}>{$t('frameleaf_photography_clear_selection')}</Button
          ><Button
            disabled={busy ||
              selected.length === 0 ||
              (!applyCredit && !applyClock && assemblyChapter === '__unchanged')}
            onclick={applyAssembly}
            >{$t('frameleaf_photography_apply_to_captures', { values: { count: selected.length } })}</Button
          ><Button disabled={busy} onclick={assemble}>{$t('frameleaf_photography_save_assembly')}</Button>
        </div>
      </div>
      <div class="phd-captures">
        {#each filtered.slice(0, limit) as capture (capture.id)}<article class="phd-capture">
            <div class="phd-capture-image">
              {#if photoUrl(capture)}<img
                  src={photoUrl(capture)}
                  alt={capture.fileName ?? $t('frameleaf_photography_client_photograph')}
                  loading="lazy"
                />{:else}<span
                  >{capture.exclusion
                    ? named('exclusion', capture.exclusion)
                    : $t('frameleaf_photography_preview_unavailable')}</span
                >{/if}
            </div>
            <div>
              <strong>{photoLabel(capture.number)}</strong><label
                ><input
                  type="checkbox"
                  disabled={!capture.eligible || busy}
                  checked={selected.includes(capture.id)}
                  onchange={(event) =>
                    (selected = event.currentTarget.checked
                      ? [...selected, capture.id]
                      : selected.filter((id) => id !== capture.id))}
                />{$t('frameleaf_photography_select_for_assembly')}</label
              ><small>{capture.fileName || $t('frameleaf_photography_capture_unavailable')}</small><small
                >{capture.camera ?? $t('frameleaf_photography_camera_unknown')} · {capture.isRaw
                  ? 'RAW'
                  : $t('frameleaf_photography_image')}{capture.assetIds.length > 1
                  ? ` · ${$t('frameleaf_photography_stacked_files', { values: { count: capture.assetIds.length } })}`
                  : ''}</small
              ><small
                >{named('processing', capture.processing)}{capture.exclusion
                  ? ` · ${named('exclusion', capture.exclusion)}`
                  : ''}</small
              >{#if capture.checksum}<details>
                  <summary>{$t('frameleaf_photography_import_checksum')}</summary><code class="phd-checksum"
                    >{capture.checksum}</code
                  >
                </details>{/if}<label
                >{$t('frameleaf_photography_photographer')}<input
                  disabled={!capture.eligible || busy}
                  maxlength="100"
                  bind:value={capture.photographer}
                /></label
              >
              <div class="phd-fields">
                <label
                  >{$t('frameleaf_photography_clock_correction')}<input
                    disabled={!capture.eligible || busy}
                    type="number"
                    step="1"
                    min="-86400"
                    max="86400"
                    bind:value={capture.offsetSeconds}
                  /></label
                ><label
                  >{$t('frameleaf_photography_block_chapter')}<select disabled={busy} bind:value={capture.chapterId}
                    ><option value={null}>{$t('frameleaf_photography_unassigned')}</option
                    >{#each draft.chapters as chapter (chapter.id)}<option value={chapter.id}>{chapter.title}</option
                      >{/each}</select
                  ></label
                >
              </div>
              <div class="phd-actions">
                {#if capture.eligible && capture.processing !== 'ready'}<Button
                    disabled={busy}
                    onclick={() => mutate(`/captures/${capture.id}/retry-processing`)}
                    >{$t('frameleaf_photography_retry_preview')}</Button
                  >{/if}
                {#if capture.eligible && capture.assetIds.length > 1}<Button
                    disabled={busy}
                    onclick={() => mutate('/intake', 'POST', { expandCaptureIds: [capture.id] })}
                    >{$t('frameleaf_photography_split_pair')}</Button
                  >{/if}
                <label
                  ><input type="checkbox" disabled={busy} bind:checked={capture.withheld} />{$t(
                    'frameleaf_photography_withhold',
                  )}</label
                ><Button
                  disabled={busy}
                  label={$t('frameleaf_photography_move_photo_earlier', { values: { number: capture.number } })}
                  onclick={() => move(capture.id, -1)}>↑</Button
                ><Button
                  disabled={busy}
                  label={$t('frameleaf_photography_move_photo_later', { values: { number: capture.number } })}
                  onclick={() => move(capture.id, 1)}>↓</Button
                >{#if capture.eligible && capture.assetId && shoot.albumId}<a
                    href={Route.viewAlbumAsset({ albumId: shoot.albumId, assetId: capture.assetId })}
                    >{$t('frameleaf_photography_open_editor')}</a
                  >{/if}
              </div>
            </div>
          </article>{/each}
      </div>
      {#if filtered.length > limit}<Button onclick={() => (limit += 80)}
          >{$t('frameleaf_photography_show_more_captures')}</Button
        >{/if}
    {:else if panel === 'workflow'}
      <section class="phd-card">
        <h3>{$t('frameleaf_photography_presets_title')}</h3>
        <p>
          {$t('frameleaf_photography_presets_body')}
        </p>
        <div class="phd-row">
          <label>{$t('frameleaf_photography_preset_name')}<input maxlength="100" bind:value={presetName} /></label
          ><Button
            disabled={busy || !presetName.trim() || (draft.studioPresets?.presets.length ?? 0) >= 30}
            onclick={() => saveStudioPreset()}>{$t('frameleaf_photography_save_preset')}</Button
          >
        </div>
        {#each draft.studioPresets?.presets ?? [] as preset (preset.id)}<div class="phd-row phd-order">
            <span>{preset.name}</span>
            <div class="phd-actions">
              <Button
                disabled={busy}
                onclick={() =>
                  mutate(`/studio-presets/${preset.id}/apply`, 'POST', {
                    expectedPresetRevision: draft!.studioPresets!.revision,
                  })}>{$t('frameleaf_photography_preset_apply')}</Button
              ><Button disabled={busy || !presetName.trim()} onclick={() => saveStudioPreset(preset.id)}
                >{$t('frameleaf_photography_preset_replace')}</Button
              >
            </div>
          </div>{:else}<p>{$t('frameleaf_photography_presets_none')}</p>{/each}
        <details>
          <summary>{$t('frameleaf_photography_snapshots')}</summary><Button
            disabled={busy || !presetName.trim() || draft.presets.length >= 30}
            onclick={() => mutate('/presets', 'POST', { id: null, name: presetName.trim(), config: draft!.config })}
            >{$t('frameleaf_photography_snapshot_save')}</Button
          >{#each draft.presets as preset (preset.id)}<div class="phd-row">
              <span>{preset.name}</span><Button disabled={busy} onclick={() => mutate(`/presets/${preset.id}/apply`)}
                >{$t('frameleaf_photography_snapshot_restore')}</Button
              >
            </div>{/each}
        </details>
      </section>
      <section class="phd-card">
        <h3>{$t('frameleaf_photography_journey_title')}</h3>
        <div class="phd-fields">
          <label
            >{$t('frameleaf_photography_collection_title')}<input
              maxlength="200"
              bind:value={draft.config.title}
            /></label
          ><label
            >{$t('frameleaf_photography_workflow')}<select bind:value={draft.config.mode}
              ><option value="edited-delivery">{$t('frameleaf_photography_mode_edited')}</option><option
                value="select-before-editing">{$t('frameleaf_photography_mode_select')}</option
              ><option value="sell-by-photo">{$t('frameleaf_photography_mode_sell')}</option></select
            ></label
          ><label
            >{$t('frameleaf_photography_payment')}<select bind:value={draft.config.paymentTiming}
              ><option value="before-editing">{$t('frameleaf_photography_payment_before')}</option><option
                value="after-approval">{$t('frameleaf_photography_payment_after')}</option
              ></select
            ></label
          ><label
            >{$t('frameleaf_photography_currency')}<input maxlength="3" bind:value={draft.config.currency} /></label
          ><label
            >{$t('frameleaf_photography_included_photographs')}<input
              type="number"
              min="0"
              step="1"
              bind:value={draft.config.includedCount}
            /></label
          ><label
            >{$t('frameleaf_photography_additional_price')}<input
              type="number"
              min="0"
              step="0.01"
              value={draft.config.additionalPrice / 100}
              onchange={(event) => {
                draft!.config.additionalPrice = Math.round(event.currentTarget.valueAsNumber * 100);
              }}
            /></label
          ><label
            >{$t('frameleaf_photography_collection_price')}<input
              type="number"
              min="0"
              step="0.01"
              value={draft.config.collectionPrice === null ? '' : draft.config.collectionPrice / 100}
              onchange={(event) => {
                draft!.config.collectionPrice =
                  event.currentTarget.value === '' ? null : Math.round(event.currentTarget.valueAsNumber * 100);
              }}
              placeholder={$t('frameleaf_photography_not_offered')}
            /></label
          ><label
            >{$t('frameleaf_photography_turnaround')}<input
              type="number"
              min="0"
              max="365"
              step="1"
              bind:value={draft.config.turnaroundDays}
            /></label
          ><label
            >{$t('frameleaf_photography_selection_deadline')}<input
              type="date"
              value={draft.config.selectionDeadline?.slice(0, 10) ?? ''}
              onchange={(event) => {
                draft!.config.selectionDeadline = event.currentTarget.value
                  ? new Date(`${event.currentTarget.value}T23:59:59`).toISOString()
                  : null;
              }}
            /></label
          ><label
            >{$t('frameleaf_photography_gallery_expiry')}<input
              type="date"
              value={draft.config.expiresAt?.slice(0, 10) ?? ''}
              onchange={(event) => {
                draft!.config.expiresAt = event.currentTarget.value
                  ? new Date(`${event.currentTarget.value}T23:59:59`).toISOString()
                  : null;
              }}
            /></label
          >
        </div>
        <p>
          {$t('frameleaf_photography_additional_price_note', {
            values: { price: money(draft.config.additionalPrice) },
          })}
        </p>
        <label
          >{$t('frameleaf_photography_client_terms')}<textarea maxlength="4000" rows="4" bind:value={draft.config.terms}
          ></textarea></label
        >
        <div class="phd-row">
          <h4>{$t('frameleaf_photography_bundles')}</h4>
          <Button
            disabled={busy || draft.config.bundles.length >= 20}
            onclick={() => {
              draft!.config.bundles.push({ count: 5, price: 0 });
            }}>{$t('frameleaf_photography_add_bundle')}</Button
          >
        </div>
        {#each draft.config.bundles as bundle, index (index)}<div class="phd-fields">
            <label
              >{$t('frameleaf_photography_client_photographs')}<input
                type="number"
                min="1"
                step="1"
                bind:value={bundle.count}
              /></label
            ><label
              >{$t('frameleaf_photography_bundle_price')}<input
                type="number"
                min="0"
                step="0.01"
                value={bundle.price / 100}
                onchange={(event) => {
                  bundle.price = Math.round(event.currentTarget.valueAsNumber * 100);
                }}
              /></label
            ><Button onclick={() => draft!.config.bundles.splice(index, 1)}
              >{$t('frameleaf_photography_remove_bundle')}</Button
            >
          </div>{/each}
      </section>
      <section class="phd-card">
        <h3>{$t('frameleaf_photography_proof_protection')}</h3>
        <p>{$t('frameleaf_photography_proof_protection_body')}</p>
        <PhotographyWatermarkEditor bind:value={draft.config.proofWatermark} disabled={busy} />
      </section>
      <section class="phd-card">
        <h3>{$t('frameleaf_photography_web_previews')}</h3>
        <label
          ><input
            type="checkbox"
            checked={draft.config.webWatermark !== null}
            onchange={(event) =>
              (draft!.config.webWatermark = event.currentTarget.checked
                ? structuredClone($state.snapshot(draft!.config.proofWatermark))
                : null)}
          />{$t('frameleaf_photography_web_watermark_toggle')}</label
        >{#if draft.config.webWatermark}<PhotographyWatermarkEditor
            bind:value={draft.config.webWatermark}
            disabled={busy}
          />{/if}
      </section>
      <section class="phd-card">
        <h3>{$t('frameleaf_photography_final_downloads')}</h3>
        <p>
          {$t('frameleaf_photography_final_downloads_body')}
        </p>
        <label
          ><input
            type="checkbox"
            checked={draft.config.downloadWatermark !== null}
            onchange={(event) =>
              (draft!.config.downloadWatermark = event.currentTarget.checked
                ? structuredClone($state.snapshot(draft!.config.proofWatermark))
                : null)}
          />{$t('frameleaf_photography_watermark_exports')}</label
        >{#if draft.config.downloadWatermark}<PhotographyWatermarkEditor
            bind:value={draft.config.downloadWatermark}
            disabled={busy}
          />{/if}
      </section>
      <section class="phd-card">
        <h3>{$t('frameleaf_photography_outputs_title')}</h3>
        <p>
          {$t('frameleaf_photography_outputs_body')}
        </p>
        <div class="phd-actions">
          <Button disabled={busy || (draft.config.downloadOutputs?.length ?? 1) >= 6} onclick={() => addOutput('print')}
            >{$t('frameleaf_photography_add_print')}</Button
          ><Button disabled={busy || (draft.config.downloadOutputs?.length ?? 1) >= 6} onclick={() => addOutput('web')}
            >{$t('frameleaf_photography_add_web')}</Button
          ><Button
            disabled={busy || (draft.config.downloadOutputs?.length ?? 1) >= 6}
            onclick={() => addOutput('social')}>{$t('frameleaf_photography_add_social')}</Button
          >
        </div>
        {#each draft.config.downloadOutputs ?? [] as output, index (output.key)}<div class="phd-order">
            <div class="phd-fields">
              <label
                >{$t('frameleaf_photography_file_label')}<input
                  maxlength="100"
                  disabled={busy}
                  bind:value={output.label}
                /></label
              ><label
                >{$t('frameleaf_photography_size')}<select
                  disabled={busy}
                  bind:value={output.kind}
                  onchange={() => {
                    output.maxEdge = output.kind === 'print' ? 65_535 : 2048;
                  }}
                  ><option value="print">{$t('frameleaf_photography_full_resolution')}</option><option value="web"
                    >{$t('frameleaf_photography_size_web')}</option
                  ><option value="social">{$t('frameleaf_photography_size_social')}</option></select
                ></label
              >{#if output.kind !== 'print'}<label
                  >{$t('frameleaf_photography_longest_edge')}<input
                    type="number"
                    min="320"
                    max="4096"
                    step="1"
                    disabled={busy}
                    bind:value={output.maxEdge}
                  /></label
                >{/if}
            </div>
            <label
              ><input
                type="checkbox"
                disabled={busy}
                checked={output.watermark !== null}
                onchange={(event) => {
                  output.watermark = event.currentTarget.checked
                    ? structuredClone($state.snapshot(draft!.config.downloadWatermark ?? draft!.config.proofWatermark))
                    : null;
                }}
              />{$t('frameleaf_photography_output_watermark')}</label
            >
            {#if output.watermark}<PhotographyWatermarkEditor bind:value={output.watermark} disabled={busy} />{:else}<p>
                {$t('frameleaf_photography_clean_edit_note')}
              </p>{/if}
            <Button
              disabled={busy || draft.config.downloadOutputs!.length === 1}
              onclick={() => {
                draft!.config.downloadOutputs!.splice(index, 1);
              }}>{$t('frameleaf_photography_remove_output')}</Button
            >
          </div>{:else}<p>{$t('frameleaf_photography_outputs_default')}</p>{/each}
        {#if draft.config.downloadOutputs}<Button
            disabled={busy}
            onclick={() => {
              delete draft!.config.downloadOutputs;
            }}>{$t('frameleaf_photography_outputs_reset')}</Button
          >{/if}
      </section>
      {#if brand?.brand.watermarkPresets?.length}<section class="phd-card">
          <h3>{$t('frameleaf_photography_watermark_presets')}</h3>
          {#each brand.brand.watermarkPresets as preset (preset.id)}<div class="phd-row">
              <span>{preset.name} · v{preset.version}</span>
              <div class="phd-actions">
                <Button
                  disabled={busy}
                  onclick={() => (draft!.config.proofWatermark = structuredClone($state.snapshot(preset.watermark)))}
                  >{$t('frameleaf_photography_use_for_proofs')}</Button
                ><Button
                  disabled={busy}
                  onclick={() => (draft!.config.webWatermark = structuredClone($state.snapshot(preset.watermark)))}
                  >{$t('frameleaf_photography_use_for_web')}</Button
                ><Button
                  disabled={busy}
                  onclick={() => (draft!.config.downloadWatermark = structuredClone($state.snapshot(preset.watermark)))}
                  >{$t('frameleaf_photography_use_for_exports')}</Button
                >
              </div>
            </div>{/each}
        </section>{/if}
      <Button variant="primary" disabled={busy} onclick={() => mutate('/config', 'PUT', { config: draft!.config })}
        >{$t('frameleaf_photography_save_workflow')}</Button
      >
    {:else if panel === 'presentation'}
      <section class="phd-card">
        <h3>{$t('frameleaf_photography_presentation_title')}</h3>
        <div class="phd-templates">
          {#each [{ id: 'wedding', title: $t('frameleaf_photography_template_wedding'), detail: $t('frameleaf_photography_template_wedding_detail') }, { id: 'portrait', title: $t('frameleaf_photography_template_portrait'), detail: $t('frameleaf_photography_template_portrait_detail') }, { id: 'fine-art', title: $t('frameleaf_photography_template_fine_art'), detail: $t('frameleaf_photography_template_fine_art_detail') }, { id: 'proofing', title: $t('frameleaf_photography_template_proofing'), detail: $t('frameleaf_photography_template_proofing_detail') }] as template (template.id)}<button
              type="button"
              class:selected={draft.config.presentation.template === template.id}
              aria-pressed={draft.config.presentation.template === template.id}
              onclick={() =>
                (draft!.config.presentation.template = template.id as Workflow['config']['presentation']['template'])}
              ><strong>{template.title}</strong><span>{template.detail}</span></button
            >{/each}
        </div>
        <div class="phd-fields">
          <label
            >{$t('frameleaf_photography_cover_photograph')}<select bind:value={draft.config.presentation.coverCaptureId}
              ><option value={null}>{$t('frameleaf_photography_cover_first')}</option
              >{#each eligible as capture (capture.id)}<option value={capture.id}
                  >{photoLabel(capture.number)} · {capture.fileName}</option
                >{/each}</select
            ></label
          ><label
            >{$t('frameleaf_photography_cover_treatment')}<select bind:value={draft.config.presentation.coverTreatment}
              ><option value="full">{$t('frameleaf_photography_block_full')}</option><option value="split"
                >{$t('frameleaf_photography_cover_split')}</option
              ><option value="quiet">{$t('frameleaf_photography_cover_quiet')}</option></select
            ></label
          ><label
            >{$t('frameleaf_photography_cover_focal')}<input
              type="range"
              min="0"
              max="100"
              bind:value={draft.config.presentation.coverFocal}
            /></label
          ><label
            >{$t('frameleaf_photography_typography')}<select bind:value={draft.config.presentation.font}
              ><option value="editorial">{$t('frameleaf_photography_font_editorial')}</option><option value="modern"
                >{$t('frameleaf_photography_font_modern')}</option
              ><option value="script">{$t('frameleaf_photography_font_script')}</option></select
            ></label
          ><label
            >{$t('frameleaf_photography_palette')}<select bind:value={draft.config.presentation.palette}
              ><option value="studio">{$t('frameleaf_photography_palette_studio')}</option><option value="ivory"
                >{$t('frameleaf_photography_palette_ivory')}</option
              ><option value="charcoal">{$t('frameleaf_photography_palette_charcoal')}</option></select
            ></label
          ><label
            >{$t('frameleaf_photography_spacing')}<select bind:value={draft.config.presentation.spacing}
              ><option value="compact">{$t('frameleaf_photography_spacing_compact')}</option><option value="comfortable"
                >{$t('frameleaf_photography_spacing_comfortable')}</option
              ><option value="airy">{$t('frameleaf_photography_spacing_airy')}</option></select
            ></label
          >
        </div>
        <label
          >{$t('frameleaf_photography_introduction')}<textarea
            maxlength="2000"
            rows="4"
            bind:value={draft.config.presentation.introduction}></textarea></label
        >
        <div class="phd-actions">
          <label
            ><input type="checkbox" bind:checked={draft.config.presentation.showChapters} />{$t(
              'frameleaf_photography_chapter_navigation',
            )}</label
          ><label
            ><input type="checkbox" bind:checked={draft.config.presentation.showNumbers} />{$t(
              'frameleaf_photography_photo_numbers',
            )}</label
          >
        </div>
        <h3>{$t('frameleaf_photography_story_blocks')}</h3>
        <p>
          {$t('frameleaf_photography_story_blocks_body')}
        </p>
        <div class="phd-actions">
          {#each ['chapter', 'grid', 'full', 'pair', 'caption', 'slideshow'] as type (type)}<Button
              disabled={busy || (draft.config.presentation.blocks?.length ?? 0) >= 100}
              onclick={() => addBlock(type as PresentationBlock['type'])}
              >{$t('frameleaf_photography_add_block', {
                values: { type: blockTypeLabel(type as PresentationBlock['type']) },
              })}</Button
            >{/each}
        </div>
        {#each draft.config.presentation.blocks ?? [] as block, index (block.id)}<div class="phd-order">
            <div class="phd-row">
              <strong>{index + 1}. {blockTypeLabel(block.type)}</strong>
              <div class="phd-actions">
                <Button
                  disabled={busy || index === 0}
                  label={$t('frameleaf_photography_move_block_earlier', { values: { number: index + 1 } })}
                  onclick={() => moveBlock(index, -1)}>↑</Button
                ><Button
                  disabled={busy || index === draft!.config.presentation.blocks!.length - 1}
                  label={$t('frameleaf_photography_move_block_later', { values: { number: index + 1 } })}
                  onclick={() => moveBlock(index, 1)}>↓</Button
                ><Button
                  disabled={busy}
                  onclick={() => {
                    draft!.config.presentation.blocks!.splice(index, 1);
                  }}>{$t('frameleaf_photography_remove_block')}</Button
                >
              </div>
            </div>
            <div class="phd-fields">
              <label
                >{$t('frameleaf_photography_block_chapter')}<select disabled={busy} bind:value={block.chapterId}
                  ><option value={null}>{$t('frameleaf_photography_all_chapters')}</option
                  >{#each draft.chapters as chapter (chapter.id)}<option value={chapter.id}>{chapter.title}</option
                    >{/each}</select
                ></label
              ><label
                >{block.type === 'caption'
                  ? $t('frameleaf_photography_block_caption')
                  : block.type === 'chapter'
                    ? $t('frameleaf_photography_chapter_introduction')
                    : $t('frameleaf_photography_group_caption')}<textarea
                  maxlength="2000"
                  rows="3"
                  disabled={busy}
                  bind:value={block.text}></textarea></label
              >
            </div>
            {#if !['chapter', 'caption'].includes(block.type)}<details>
                <summary
                  >{block.selection === 'explicit' || block.captureIds.length > 0
                    ? $t('frameleaf_photography_block_photographs', { values: { count: block.captureIds.length } })
                    : $t('frameleaf_photography_block_photographs_automatic')}</summary
                >
                <p>
                  {$t('frameleaf_photography_block_photographs_body')}
                </p>
                <Button
                  disabled={busy}
                  onclick={() => {
                    block.selection = 'automatic';
                    block.captureIds = [];
                  }}>{$t('frameleaf_photography_use_sequence')}</Button
                >
                {#each block.captureIds as id, photoIndex (id)}<div class="phd-row">
                    <span
                      >{photoIndex + 1}. {photoLabel(
                        eligible.find((capture) => capture.id === id)?.number ??
                          $t('frameleaf_photography_unavailable_lower'),
                      )}</span
                    >
                    <div class="phd-actions">
                      <Button
                        disabled={busy || photoIndex === 0}
                        label={$t('frameleaf_photography_move_selected_earlier', {
                          values: { number: photoIndex + 1 },
                        })}
                        onclick={() => moveBlockPhoto(block, photoIndex, -1)}>↑</Button
                      >
                      <Button
                        disabled={busy || photoIndex === block.captureIds.length - 1}
                        label={$t('frameleaf_photography_move_selected_later', { values: { number: photoIndex + 1 } })}
                        onclick={() => moveBlockPhoto(block, photoIndex, 1)}>↓</Button
                      >
                    </div>
                  </div>{/each}
                {#each eligible as capture (capture.id)}<label
                    ><input
                      type="checkbox"
                      disabled={busy || (!block.captureIds.includes(capture.id) && block.captureIds.length >= 1000)}
                      checked={block.captureIds.includes(capture.id)}
                      onchange={(event) => {
                        block.selection = 'explicit';
                        block.captureIds = event.currentTarget.checked
                          ? [...block.captureIds, capture.id]
                          : block.captureIds.filter((id) => id !== capture.id);
                      }}
                    />{photoLabel(capture.number)} · {capture.fileName}</label
                  >{/each}
              </details>{/if}
          </div>{:else}<p>{$t('frameleaf_photography_blocks_none')}</p>{/each}
        <p>{$t('frameleaf_photography_presentation_save_note')}</p>
        <Button variant="primary" disabled={busy} onclick={() => mutate('/config', 'PUT', { config: draft!.config })}
          >{$t('frameleaf_photography_save_presentation')}</Button
        >
      </section>
    {:else if panel === 'orders'}
      {#if draft.config.downloadOutputs?.length}<section class="phd-card">
          <h3>{$t('frameleaf_photography_next_order_versions')}</h3>
          <p>
            {$t('frameleaf_photography_next_order_versions_body')}
          </p>
          {#each draft.config.downloadOutputs as output (output.key)}<details>
              <summary>{output.label}</summary
              >{#each eligible.filter( (capture) => draft!.approvedVersions?.some((version) => version.captureId === capture.id) ) as capture (capture.id)}<label
                  >{photoLabel(capture.number)}<select
                    value={outputVersions[output.key]?.[capture.id] ?? ''}
                    onchange={(event) => {
                      outputVersions[output.key] ??= {};
                      outputVersions[output.key][capture.id] = event.currentTarget.value;
                    }}
                    ><option value="">{$t('frameleaf_photography_normal_approval')}</option
                    >{#each draft.approvedVersions?.filter((version) => version.captureId === capture.id) ?? [] as version (version.revisionId)}<option
                        value={version.revisionId}
                        >{versionChoices[capture.id]?.find((choice) => choice.id === version.revisionId)?.label ??
                          $t('frameleaf_photography_approved_at', {
                            values: { date: new Date(version.approvedAt).toLocaleString($locale) },
                          })}</option
                      >{/each}</select
                  ></label
                ><Button disabled={busy} onclick={() => revisions(capture)}
                  >{$t('frameleaf_photography_load_version_names')}</Button
                >{:else}<p>
                  {$t('frameleaf_photography_no_approved_versions')}
                </p>{/each}
            </details>{/each}
        </section>{/if}

      {#if draft.config.mode === 'edited-delivery'}<section class="phd-card">
          <h3>{$t('frameleaf_photography_mode_edited')}</h3>
          <p>
            {$t('frameleaf_photography_edited_delivery_body')}
          </p>
          {#each draft.recipients.filter((row) => !row.revoked) as row (row.id)}<div class="phd-row phd-order">
              <strong>{row.name}</strong><Button
                disabled={busy || eligible.length === 0}
                onclick={() =>
                  mutate('/orders', 'POST', {
                    recipientId: row.id,
                    roundId: null,
                    pricing: 'package',
                    outputs: orderOutputs(
                      eligible
                        .filter((capture) => !row.captureIds || row.captureIds.includes(capture.id))
                        .map((capture) => capture.id),
                    ),
                    captureIds: eligible
                      .filter((capture) => !row.captureIds || row.captureIds.includes(capture.id))
                      .map((capture) => capture.id),
                  })}>{$t('frameleaf_photography_confirm_delivery')}</Button
              >
            </div>{:else}<p>{$t('frameleaf_photography_invite_first')}</p>{/each}
        </section>{/if}
      <section class="phd-card">
        <div class="phd-row">
          <div>
            <h3>{$t('frameleaf_photography_selection_rounds')}</h3>
            <p>
              {$t('frameleaf_photography_selection_rounds_body')}
            </p>
          </div>
          <Button disabled={!stored?.rounds.length} onclick={csv}>{$t('frameleaf_photography_export_csv')}</Button>
        </div>
        {#each draft.rounds as round (round.id)}<article class="phd-order">
            <div class="phd-row">
              <strong>{recipient(round.recipientId)} · {new Date(round.createdAt).toLocaleString($locale)}</strong><span
                >{$t('frameleaf_photography_photographs_count', { values: { count: round.captureIds.length } })}</span
              >
            </div>
            <p>
              {round.captureIds
                .map((id) => `#${draft?.captures.find((capture) => capture.id === id)?.number ?? '—'}`)
                .join(' · ')}
            </p>
            {#each round.notes as note, index (index)}<p>
                {photoLabel(draft.captures.find((capture) => capture.id === note.captureId)?.number ?? '—')}: {note.text}{#each note.annotations ?? [] as annotation, annotationIndex (annotationIndex)}<small
                    >{$t('frameleaf_photography_area_note', {
                      values: { number: annotationIndex + 1, text: annotation.text },
                    })}</small
                  >{/each}
              </p>{/each}
            <div class="phd-actions">
              <Button
                disabled={busy || draft.orders.some((order) => order.roundId === round.id)}
                onclick={() =>
                  mutate('/orders', 'POST', {
                    roundId: round.id,
                    recipientId: round.recipientId,
                    pricing: 'package',
                    outputs: orderOutputs(round.captureIds),
                  })}>{$t('frameleaf_photography_confirm_package')}</Button
              >{#if draft.config.collectionPrice !== null}<Button
                  disabled={busy}
                  onclick={() =>
                    mutate('/orders', 'POST', {
                      roundId: round.id,
                      recipientId: round.recipientId,
                      pricing: 'collection',
                      outputs: orderOutputs(eligible.map((capture) => capture.id)),
                    })}>{$t('frameleaf_photography_confirm_collection')}</Button
                >{/if}{#each draft.config.bundles as bundle, index (index)}<Button
                  disabled={busy || round.captureIds.length > bundle.count}
                  onclick={() =>
                    mutate('/orders', 'POST', {
                      roundId: round.id,
                      recipientId: round.recipientId,
                      pricing: 'bundle',
                      bundleCount: bundle.count,
                      outputs: orderOutputs(round.captureIds),
                    })}
                  >{$t('frameleaf_photography_bundle_option', {
                    values: { count: bundle.count, price: money(bundle.price) },
                  })}</Button
                >{/each}
            </div>
          </article>{:else}<p>{$t('frameleaf_photography_no_selections')}</p>{/each}
      </section>
      <section class="phd-card">
        <h3>{$t('frameleaf_photography_orders_title')}</h3>
        <label
          >{$t('frameleaf_photography_payment_reference')}<input
            maxlength="200"
            bind:value={paymentReference}
            placeholder={$t('frameleaf_photography_payment_reference_placeholder')}
          /></label
        >{#each draft.orders as order (order.id)}<article class="phd-order">
            <div class="phd-row">
              <strong>{recipient(order.recipientId)} · {money(order.total, order.currency)}</strong><span
                >{named('order', order.status)}</span
              >
            </div>
            <p>
              {$t('frameleaf_photography_photographs_count', { values: { count: order.captureIds.length } })} · {order.paymentTiming ===
              'before-editing'
                ? $t('frameleaf_photography_payment_before_editing')
                : $t('frameleaf_photography_payment_after_approval')}
            </p>
            <p>{order.terms}</p>
            <div class="phd-actions">
              {#if canSettle(order)}<Button
                  disabled={busy || !paymentReference.trim()}
                  onclick={() =>
                    mutate(`/orders/${order.id}/payment`, 'POST', { action: 'settle', reference: paymentReference })}
                  >{$t('frameleaf_photography_record_payment')}</Button
                ><Button
                  disabled={busy || !paymentReference.trim()}
                  onclick={() =>
                    mutate(`/orders/${order.id}/payment`, 'POST', { action: 'cancel', reference: paymentReference })}
                  >{$t('frameleaf_photography_cancel_order')}</Button
                >{:else if order.status === 'settled'}<Button
                  disabled={busy || !paymentReference.trim()}
                  onclick={() =>
                    mutate(`/orders/${order.id}/payment`, 'POST', { action: 'refund', reference: paymentReference })}
                  >{$t('frameleaf_photography_record_refund')}</Button
                >{:else if order.status === 'quoted'}<Button
                  disabled={busy || !paymentReference.trim()}
                  onclick={() =>
                    mutate(`/orders/${order.id}/payment`, 'POST', { action: 'cancel', reference: paymentReference })}
                  >{$t('frameleaf_photography_cancel_quote')}</Button
                >{/if}
            </div>
          </article>{:else}<p>
            {$t('frameleaf_photography_no_orders')}
          </p>{/each}{#each draft.receipts as receipt (receipt.id)}<small
            >{new Date(receipt.createdAt).toLocaleString($locale)} · {named('receipt', receipt.action)} · {receipt.reference}</small
          >{/each}
      </section>
      <section class="phd-card">
        <h3>{$t('frameleaf_photography_approve_versions')}</h3>
        <label
          ><input type="checkbox" bind:checked={clientApproval} />{$t(
            'frameleaf_photography_request_client_approval',
          )}</label
        >{#each eligible.filter( (capture) => draft?.orders.some( (order) => order.captureIds.includes(capture.id) ) ) as capture (capture.id)}<div
            class="phd-order"
          >
            <div class="phd-row">
              <strong>{photoLabel(capture.number)} · {capture.fileName}</strong><span
                >{named('photo', capture.state)}</span
              >
            </div>
            <div class="phd-actions">
              {#if shoot.albumId && capture.assetId}<a
                  href={Route.viewAlbumAsset({ albumId: shoot.albumId, assetId: capture.assetId })}
                  >{$t('frameleaf_photography_edit_photograph')}</a
                >{/if}<Button disabled={busy} onclick={() => revisions(capture)}
                >{$t('frameleaf_photography_load_ready_versions')}</Button
              >{#if versionChoices[capture.id]}<label
                  >{$t('frameleaf_photography_version')}<select bind:value={pinnedChoices[capture.id]}
                    ><option value="">{$t('frameleaf_photography_choose_version')}</option
                    >{#each versionChoices[capture.id] as revision (revision.id)}<option value={revision.id}
                        >{revision.label}</option
                      >{/each}</select
                  ></label
                ><Button
                  disabled={busy || (pinnedChoices[capture.id]?.length ?? 0) === 0}
                  onclick={() =>
                    mutate('/approvals', 'POST', {
                      captureId: capture.id,
                      revisionId: pinnedChoices[capture.id],
                      requestClientApproval: clientApproval,
                    })}>{$t('frameleaf_photography_approve_version')}</Button
                >{/if}
            </div>
          </div>{:else}<p>{$t('frameleaf_photography_approve_none')}</p>{/each}
      </section>
    {:else if panel === 'publishing'}
      <section class="phd-card">
        <h3>{$t('frameleaf_photography_client_collection_title')}</h3>
        <p>
          {$t('frameleaf_photography_publish_body')}
        </p>
        <div class="phd-row">
          <strong
            >{draft.publication
              ? named('publication', draft.publication.status)
              : $t('frameleaf_photography_draft')}</strong
          ><span
            >{$t('frameleaf_photography_prepared_count', {
              values: { done: draft.publication?.completed ?? 0, total: draft.publication?.total ?? 0 },
            })}</span
          >
        </div>
        {#if draft.publication?.error || draft.publication?.status === 'failed'}<p role="alert">
            {$t('frameleaf_photography_publish_failed')}
          </p>{/if}
        <div class="phd-actions">
          <Button
            variant="primary"
            disabled={busy}
            onclick={() => mutate('/publish', 'POST', { scope: 'all-eligible' })}
            >{$t('frameleaf_photography_publish_all')}</Button
          ><Button
            disabled={busy || draft.rounds.length === 0}
            onclick={() => mutate('/publish', 'POST', { scope: 'selected' })}
            >{$t('frameleaf_photography_publish_selected')}</Button
          >{#if ['failed', 'queued', 'rendering'].includes(draft.publication?.status ?? '')}<Button
              disabled={busy}
              onclick={() => mutate('/retry')}>{$t('frameleaf_photography_publish_retry')}</Button
            >{/if}
        </div>
      </section>
      <section class="phd-card">
        <h3>{$t('frameleaf_photography_invite_title')}</h3>
        <p>{$t('frameleaf_photography_invite_body')}</p>
        <div class="phd-fields">
          <label>{$t('frameleaf_photography_recipient_name')}<input maxlength="100" bind:value={recipientName} /></label
          ><label
            >{$t('frameleaf_photography_gallery_password_optional')}<input
              type="password"
              autocomplete="new-password"
              minlength="8"
              maxlength="72"
              bind:value={recipientPassword}
            /></label
          ><label
            >{$t('frameleaf_photography_invitation_expiry')}<input type="date" bind:value={recipientExpiry} /></label
          >
        </div>
        <label
          ><input type="checkbox" bind:checked={recipientDownload} />{$t(
            'frameleaf_photography_allow_downloads_paid',
          )}</label
        ><label
          ><input type="checkbox" bind:checked={restrictInvitation} />{$t(
            'frameleaf_photography_restrict_captures',
          )}</label
        >{#if selected.length}<p>
            {$t('frameleaf_photography_captures_in_invitation', { values: { count: selected.length } })}
          </p>{/if}{#if restrictInvitation}<div class="phd-recipient-captures">
            {#each eligible as capture (capture.id)}<label
                ><input
                  type="checkbox"
                  checked={selected.includes(capture.id)}
                  onchange={(event) =>
                    (selected = event.currentTarget.checked
                      ? [...selected, capture.id]
                      : selected.filter((id) => id !== capture.id))}
                />{photoLabel(capture.number)} · {capture.fileName}</label
              >{/each}
          </div>{/if}<Button
          disabled={busy ||
            !recipientName.trim() ||
            (restrictInvitation && selected.length === 0) ||
            (recipientPassword.length > 0 && recipientPassword.length < 8)}
          onclick={() =>
            mutate('/recipients', 'POST', {
              name: recipientName.trim(),
              password: recipientPassword || null,
              expiresAt: recipientExpiry ? new Date(`${recipientExpiry}T23:59:59`).toISOString() : null,
              canProof: true,
              canDownload: recipientDownload,
              captureIds: restrictInvitation ? selected : null,
            })}>{$t('frameleaf_photography_create_invitation')}</Button
        >{#if invitation}<label
            >{$t('frameleaf_photography_invitation_once')}<input readonly value={invitation} /></label
          ><Button onclick={copyInvitation}>{$t('frameleaf_photography_copy_invitation')}</Button>{/if}
      </section>
      <section class="phd-card">
        <h3>{$t('frameleaf_photography_recipient_access')}</h3>
        {#each draft.recipients as row (row.id)}<div class="phd-order">
            <div class="phd-row">
              <strong>{row.name}</strong><span
                >{row.revoked
                  ? $t('frameleaf_photography_access_revoked')
                  : $t('frameleaf_photography_shoots_active')}</span
              >
            </div>
            <p>
              {row.canProof ? $t('frameleaf_photography_proofing_on') : $t('frameleaf_photography_proofing_off')} · {row.canDownload
                ? $t('frameleaf_photography_downloads_on')
                : $t('frameleaf_photography_downloads_off')}{row.expiresAt
                ? ` · ${$t('frameleaf_photography_expires_on', { values: { date: new Date(row.expiresAt).toLocaleDateString($locale) } })}`
                : ''}
            </p>
            <div class="phd-actions">
              <Button
                disabled={busy}
                onclick={() =>
                  mutate(`/recipients/${row.id}`, 'PATCH', {
                    revoked: !row.revoked,
                    canProof: row.canProof,
                    canDownload: row.canDownload,
                    captureIds: row.captureIds,
                    expiresAt: row.expiresAt,
                  })}
                >{row.revoked
                  ? $t('frameleaf_photography_restore_access')
                  : $t('frameleaf_photography_revoke_access')}</Button
              ><Button
                disabled={busy}
                onclick={() =>
                  mutate(`/recipients/${row.id}`, 'PATCH', {
                    revoked: row.revoked,
                    canProof: row.canProof,
                    canDownload: !row.canDownload,
                    captureIds: row.captureIds,
                    expiresAt: row.expiresAt,
                  })}
                >{row.canDownload
                  ? $t('frameleaf_photography_disable_downloads')
                  : $t('frameleaf_photography_allow_downloads')}</Button
              >
            </div>
          </div>{:else}<p>{$t('frameleaf_photography_no_recipients')}</p>{/each}
      </section>
    {/if}
  {/if}
</div>
