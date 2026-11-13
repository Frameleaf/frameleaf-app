<script lang="ts">
  /**
   * One shoot's client work: the shoot strip (cover, counts, Client preview), the tabs for its
   * sections, and the section itself. `publishing` is the Galleries section, which shows the strip
   * without the tabs.
   */
  import { newRequestKey } from '$lib/frameleaf/request-key';
  import { onMount, onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { AssetMediaSize, getAssetDevelop } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCameraOutline,
    mdiImageOutline,
    mdiCameraPlusOutline,
    mdiCartOutline,
    mdiCheck,
    mdiEyeOutline,
    mdiHeartOutline,
    mdiImageCheckOutline,
    mdiShieldLockOutline,
    mdiBrushOutline,
    mdiChevronRight,
    mdiStarOutline,
    mdiAccountOutline,
    mdiDownloadOutline,
    mdiHeart,
    mdiLockOutline,
    mdiShieldCheckOutline,
  } from '@mdi/js';
  import Button from './Button.svelte';
  import PhotographyShootTabs, { type ShootTab } from './PhotographyShootTabs.svelte';
  import PhotographyThumb from './PhotographyThumb.svelte';
  import PhotographyWatermarkEditor from './PhotographyWatermarkEditor.svelte';
  import { photographyErrorKey, photographyLabelKey, type PhotographyLabel } from './PhotographyStatus.svelte';
  import { loadBrand, shootCover, type Shoot, type Branding } from '$lib/frameleaf/photography/api';
  import {
    galleryPreviewSession,
    workflowRequest,
    studioPresetsRequest,
    type Workflow,
    type Capture,
    type Order,
    type OutputDefinition,
    type PresentationBlock,
  } from '$lib/frameleaf/photography/workflow-api';
  import { endOfLocalDayIso, localDateInput } from '$lib/frameleaf/photography/date-input';
  import { fileUploadHandler, openFileUploadDialog } from '$lib/utils/file-uploader';
  import { getAssetMediaUrl } from '$lib/utils';
  import { Route } from '$lib/route';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';

  let {
    shoot,
    panel = 'intake',
    onSection,
    onGalleries,
    onWatermarks,
    onSaveBrief,
  }: {
    shoot: Shoot;
    /** `publishing` is the shoot's Gallery tab. */
    panel?: Exclude<ShootTab, 'photos' | 'galleries'> | 'publishing';
    /** Another tab under the strip; without it the tabs are not shown. */
    onSection?: (tab: ShootTab) => void;
    /** The shoot's Gallery, where invitations, passwords and expiry live. */
    onGalleries?: () => void;
    /** Studio › Watermarks, where the marks are designed. */
    onWatermarks?: () => void;
    /** Saves the shoot brief with the shoot (it lives in the workspace, not the gallery). */
    onSaveBrief?: (brief: {
      notes: string;
      deliveryTarget: string | null;
      defaultArtist?: string;
      defaultCopyright?: string;
    }) => Promise<boolean>;
  } = $props();
  let briefNotes = $state(shoot.notes ?? '');
  let briefTarget = $state(shoot.deliveryTarget ?? '');
  let defaultArtist = $state(shoot.defaultArtist ?? '');
  let defaultCopyright = $state(shoot.defaultCopyright ?? '');
  const briefChanged = $derived(
    briefNotes !== (shoot.notes ?? '') ||
      (briefTarget || null) !== (shoot.deliveryTarget ?? null) ||
      defaultArtist.trim() !== (shoot.defaultArtist ?? '') ||
      defaultCopyright.trim() !== (shoot.defaultCopyright ?? ''),
  );
  /** The three ways of working a client gallery, as cards (PhotographyWorkflow.jsx WORKFLOW_MODES). */
  const journeys = [
    {
      mode: 'edited-delivery',
      icon: mdiImageCheckOutline,
      name: 'frameleaf_photography_mode_edited',
      detail: 'frameleaf_photography_mode_edited_detail',
    },
    {
      mode: 'select-before-editing',
      icon: mdiHeartOutline,
      name: 'frameleaf_photography_mode_select',
      detail: 'frameleaf_photography_mode_select_detail',
    },
    {
      mode: 'sell-by-photo',
      icon: mdiCartOutline,
      name: 'frameleaf_photography_mode_sell',
      detail: 'frameleaf_photography_mode_sell_detail',
    },
  ] as const;
  /** The client's path through each way of working, under Protection & delivery. */
  const flowSteps = {
    'edited-delivery': [
      'frameleaf_photography_flow_edit',
      'frameleaf_photography_flow_approve',
      'frameleaf_photography_flow_deliver',
    ],
    'select-before-editing': [
      'frameleaf_photography_flow_proof',
      'frameleaf_photography_flow_choose',
      'frameleaf_photography_flow_edit_pay',
      'frameleaf_photography_flow_deliver',
    ],
    'sell-by-photo': [
      'frameleaf_photography_flow_proof',
      'frameleaf_photography_flow_buy',
      'frameleaf_photography_flow_deliver',
    ],
  } as const;
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
  let recipientEmail = $state('');
  let recipientPassword = $state('');
  let recipientExpiry = $state('');
  let recipientDownload = $state(false);
  let invitation = $state('');
  let paymentReference = $state('');
  let versionChoices = $state<Record<string, { id: string; label: string }[]>>({});
  let pinnedChoices = $state<Record<string, string>>({});
  let outputVersions = $state<Record<string, Record<string, string>>>({});
  let clientApproval = $state(true);
  let previewing = $state(false);
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
  // ── Gallery page ──
  const activeRecipients = $derived(draft?.recipients.filter((row) => !row.revoked) ?? []);
  /** Every client's favourites so far, in capture order. */
  const clientChoices = $derived.by(() => {
    const chosen = new Set(activeRecipients.flatMap((row) => row.choices ?? []));
    return draft?.captures.filter((capture) => chosen.has(capture.id)) ?? [];
  });
  const coverAsset = $derived(
    draft?.captures.find((capture) => capture.id === draft?.config.presentation.coverCaptureId)?.assetId ??
      shoot.coverAssetId ??
      eligible[0]?.assetId ??
      null,
  );
  /** Presentation's template covers: the paper the client gallery uses (gallery.css `.pc`), the
   *  cover and the next three photographs of this collection. */
  const coverPaper = $derived.by(() => {
    const palette = draft?.config.presentation.palette;
    if (palette === 'ivory') {
      return { background: '#f6f3ed', text: '#2d332d' };
    }
    if (palette === 'charcoal') {
      return { background: '#171b19', text: '#e9e6df' };
    }
    return { background: brand?.brand.background ?? '#f6f3ed', text: brand?.brand.textColor ?? '#2d332d' };
  });
  const coverThumbs = $derived.by(() => {
    const ids = eligible
      .map((capture) => capture.assetId)
      .filter((id): id is string => !!id && id !== coverAsset)
      .slice(0, 3);
    return [...ids, ...Array.from({ length: 3 - ids.length }, () => null)];
  });
  const galleryExpired = $derived(!!draft?.config.expiresAt && Date.parse(draft.config.expiresAt) < Date.now());
  const galleryStage = $derived(
    galleryExpired
      ? $t('frameleaf_photography_gallery_expired')
      : !draft?.publication
        ? $t('frameleaf_photography_draft')
        : draft.rounds.length > 0
          ? $t('frameleaf_photography_selection_sent')
          : $t('frameleaf_photography_gallery_proofing'),
  );
  const gallerySettingsChanged = $derived(
    !!draft &&
      !!stored &&
      ((draft.config.expiresAt ?? null) !== (stored.config.expiresAt ?? null) ||
        (draft.config.maxSelections ?? null) !== (stored.config.maxSelections ?? null)),
  );

  /** Every order that still counts (not cancelled or refunded), added up for each currency. */
  const orderTotals = $derived.by(() => {
    const totals = new Map<string, number>();
    for (const order of draft?.orders ?? []) {
      if (order.status !== 'cancelled' && order.status !== 'refunded') {
        totals.set(order.currency, (totals.get(order.currency) ?? 0) + order.total);
      }
    }
    return [...totals];
  });
  const money = (amount: number, currency = draft?.config.currency ?? 'USD') => {
    try {
      return new Intl.NumberFormat($locale, { style: 'currency', currency }).format(amount / 100);
    } catch {
      return `${amount / 100} ${currency}`;
    }
  };
  /**
   * A photo's image address, or null when the shoot says the server has no preview for it yet
   * (`processing` is only "ready" once the preview exists, and the thumbnail is made in the same
   * job), so a RAW the server cannot develop shows the placeholder without a failed request.
   */
  const mediaUrl = (id: string | null | undefined, size: AssetMediaSize = AssetMediaSize.Thumbnail) => {
    if (!id) {
      return null;
    }
    const capture = draft?.captures.find((row) => row.assetId === id);
    return capture && capture.processing !== 'ready' ? null : getAssetMediaUrl({ id, size });
  };
  const photoUrl = (capture: Capture) => (capture.eligible ? mediaUrl(capture.assetId) : null);
  const galleryCoverUrl = $derived(mediaUrl(coverAsset, AssetMediaSize.Preview));
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
      key: `${kind}-${newRequestKey().slice(0, 8)}`,
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
      id: newRequestKey(),
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
        Workflow | { workflow: Workflow; invitation: { recipientId: string; token: string; emailed?: boolean } }
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
        if (typeof body.email === 'string') {
          message = result.invitation.emailed
            ? $t('frameleaf_photography_invitation_emailed', { values: { email: body.email } })
            : $t('frameleaf_photography_invitation_not_emailed');
          recipientEmail = '';
          return;
        }
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
  /** Photographs dropped on the intake zone go to the shoot's album, as Import files does. */
  let dropOver = $state(false);
  async function dropFiles(event: DragEvent) {
    event.preventDefault();
    // The page has its own drop-to-upload; this drop belongs to the shoot.
    event.stopPropagation();
    dropOver = false;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!shoot.albumId || busy || files.length === 0) {
      return;
    }
    busy = true;
    error = '';
    try {
      await fileUploadHandler({ files, albumId: shoot.albumId });
      if (!disposed) {
        busy = false;
        await mutate('/intake');
      }
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
      id: newRequestKey(),
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
  /**
   * Opens the published gallery in a new tab exactly as the client sees it, with a short preview
   * session the server keeps from changing anything. The tab opens at once, so the browser keeps
   * it as the click's own window, and goes to the gallery once the session arrives.
   */
  async function clientPreview() {
    if (previewing || !stored) {
      return;
    }
    if (!stored.publication) {
      // Nothing is published yet, so the client would see an empty gallery: say what to do instead.
      error = '';
      message = $t('frameleaf_photography_client_preview_unpublished');
      return;
    }
    const tab = window.open('about:blank', '_blank');
    if (tab) {
      tab.opener = null;
    }
    previewing = true;
    error = '';
    try {
      const { session, expiresAt } = await galleryPreviewSession(shoot.id);
      const url = new URL(`/photography/gallery/${shoot.id}`, location.origin);
      url.hash = new URLSearchParams({ preview: session, expires: expiresAt }).toString();
      if (tab && !tab.closed) {
        tab.location.href = url.href;
      } else if (!disposed) {
        location.assign(url.href);
      }
    } catch (error_) {
      tab?.close();
      if (disposed) {
        return;
      }
      // 409: the server has nothing published to show yet, the same as the check above.
      if ((error_ as { status?: number })?.status === 409) {
        message = $t('frameleaf_photography_client_preview_unpublished');
      } else {
        error = describe(error_);
      }
    } finally {
      previewing = false;
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
  <div class="phx-shoot-head">
    <div class="phx-project-context">
      <span class="phx-project-cover"
        >{#if mediaUrl(shootCover(shoot))}<PhotographyThumb
            src={mediaUrl(shootCover(shoot))}
            loading="eager"
          />{:else}<Icon icon={mdiCameraOutline} size="1.4rem" aria-hidden={true} />{/if}</span
      >
      <span class="phx-project-text"
        ><strong>{shoot.name}</strong><small
          >{[
            shoot.client,
            ...(draft
              ? [
                  $t('frameleaf_photography_capture_count', { values: { count: draft.captures.length } }),
                  $t('frameleaf_photography_eligible_proof_count', { values: { count: eligible.length } }),
                ]
              : []),
          ].join(' · ')}</small
        ></span
      >
      <Button disabled={previewing || !stored} onclick={clientPreview}
        ><Icon icon={mdiEyeOutline} size="1.1rem" aria-hidden={true} />{$t(
          'frameleaf_photography_client_preview',
        )}</Button
      >
    </div>
    {#if onSection}<PhotographyShootTabs current={panel === 'publishing' ? 'galleries' : panel} {onSection} />{/if}
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
    {#if panel === 'intake'}
      <!-- The prototype's two columns: bring the shoot together, beside the shoot brief. -->
      <div class="phx-two-column phx-intake-top">
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
          {#if shoot.albumId}<button
              type="button"
              class="phx-drop"
              class:over={dropOver}
              disabled={busy}
              onclick={() => intake()}
              ondragover={(event) => {
                if (event.dataTransfer?.types.includes('Files')) {
                  event.preventDefault();
                  event.stopPropagation();
                  dropOver = true;
                }
              }}
              ondragleave={() => (dropOver = false)}
              ondrop={dropFiles}
              ><Icon icon={mdiCameraPlusOutline} size="1.8rem" aria-hidden={true} /><strong
                >{$t('frameleaf_photography_drop_title')}</strong
              ><span>{$t('frameleaf_photography_drop_body')}</span></button
            >{/if}
        </section>
        {#if onSaveBrief}<section class="phd-card">
            <span class="phx-eyebrow">{$t('frameleaf_photography_shoot_brief')}</span>
            <label
              >{$t('frameleaf_photography_client_notes')}<textarea
                rows="3"
                maxlength="5000"
                placeholder={$t('frameleaf_photography_client_notes_placeholder')}
                bind:value={briefNotes}></textarea></label
            ><label>{$t('frameleaf_photography_delivery_target')}<input type="date" bind:value={briefTarget} /></label>
            <div class="phx-import-stats">
              <span
                ><strong>{draft.captures.filter((capture) => capture.isRaw).length}</strong>{$t(
                  'frameleaf_photography_stat_raw_sources',
                )}</span
              >
              <span
                ><strong>{draft.captures.filter((capture) => capture.assetIds.length > 1).length}</strong>{$t(
                  'frameleaf_photography_stat_paired',
                )}</span
              >
              <span
                ><strong
                  >{draft.captures.filter((capture) => !capture.eligible || capture.processing === 'failed')
                    .length}</strong
                >{$t('frameleaf_photography_stat_attention')}</span
              >
              <span
                ><strong>{draft.captures.filter((capture) => capture.withheld).length}</strong>{$t(
                  'frameleaf_photography_stat_withheld',
                )}</span
              >
            </div>
            <h3>{$t('frameleaf_metadata_default_credits')}</h3>
            <p>{$t('frameleaf_metadata_default_credits_help')}</p>
            <label>{$t('frameleaf_metadata_artist')}<input bind:value={defaultArtist} maxlength="500" /></label>
            <label>{$t('frameleaf_metadata_copyright')}<input bind:value={defaultCopyright} maxlength="500" /></label>
            <Button
              disabled={busy || !briefChanged}
              onclick={() =>
                onSaveBrief({
                  notes: briefNotes,
                  deliveryTarget: briefTarget || null,
                  ...(defaultArtist.trim() !== (shoot.defaultArtist ?? '') && { defaultArtist: defaultArtist.trim() }),
                  ...(defaultCopyright.trim() !== (shoot.defaultCopyright ?? '') && {
                    defaultCopyright: defaultCopyright.trim(),
                  }),
                })}>{$t('frameleaf_photography_save_brief')}</Button
            >
          </section>{/if}
      </div>
      <section class="phd-card">
        <div class="phd-row">
          <div>
            <h3>{$t('frameleaf_photography_chapters_title')}</h3>
            <p>{$t('frameleaf_photography_chapters_body')}</p>
          </div>
          <div class="phd-actions">
            {#if onSection}<Button onclick={() => onSection('photos')}
                ><Icon icon={mdiStarOutline} size="1.1rem" aria-hidden={true} />{$t(
                  'frameleaf_photography_cull_rate',
                )}</Button
              >{/if}<Button disabled={busy} onclick={addChapter}>{$t('frameleaf_photography_add_chapter')}</Button>
          </div>
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
              {#if photoUrl(capture)}<PhotographyThumb
                  src={photoUrl(capture)}
                  alt={capture.fileName ?? $t('frameleaf_photography_client_photograph')}
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
              >{#if capture.artist || capture.copyright}<small
                  >{[capture.artist, capture.copyright].filter(Boolean).join(' · ')}</small
                >{/if}<small
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
      <!-- PhotographyWorkflow.jsx: pick a way of working first, then the package and the protection. -->
      <section class="phd-card">
        <span class="phx-eyebrow">{$t('frameleaf_photography_journey_eyebrow')}</span>
        <h3>{$t('frameleaf_photography_journey_heading')}</h3>
        <p>{$t('frameleaf_photography_journey_lead')}</p>
        <div class="phx-mode-grid" role="group" aria-label={$t('frameleaf_photography_journey_eyebrow')}>
          {#each journeys as journey (journey.mode)}<button
              type="button"
              aria-pressed={draft.config.mode === journey.mode}
              disabled={busy}
              onclick={() => (draft!.config.mode = journey.mode)}
              ><Icon icon={journey.icon} size="1.45rem" aria-hidden={true} /><strong>{$t(journey.name)}</strong><span
                >{$t(journey.detail)}</span
              >{#if draft.config.mode === journey.mode}<small
                  ><Icon icon={mdiCheck} size="0.875rem" aria-hidden={true} />{$t(
                    'frameleaf_photography_journey_chosen',
                  )}</small
                >{/if}</button
            >{/each}
        </div>
      </section>
      <div class="phx-two-column">
        <section class="phd-card">
          <h3>{$t('frameleaf_photography_package_title')}</h3>
          <label
            >{$t('frameleaf_photography_proof_collection')}<select
              value={draft.config.proofCollection ?? 'eligible'}
              onchange={(event) =>
                (draft!.config.proofCollection = event.currentTarget.value as 'eligible' | 'selected')}
              ><option value="eligible">{$t('frameleaf_photography_proof_collection_eligible')}</option><option
                value="selected">{$t('frameleaf_photography_proof_collection_selected')}</option
              ></select
            ><small>{$t('frameleaf_photography_proof_collection_hint')}</small></label
          >
          <div class="phd-fields">
            <label
              >{$t('frameleaf_photography_collection_title')}<input
                maxlength="200"
                bind:value={draft.config.title}
              /></label
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
              >{$t('frameleaf_photography_max_selections')}<input
                type="number"
                min="1"
                max="10000"
                step="1"
                value={draft.config.maxSelections ?? ''}
                placeholder={$t('frameleaf_photography_no_limit')}
                onchange={(event) => {
                  draft!.config.maxSelections =
                    event.currentTarget.value === ''
                      ? null
                      : Math.max(1, Math.min(10_000, Math.round(event.currentTarget.valueAsNumber)));
                }}
              /></label
            ><label
              >{$t('frameleaf_photography_selection_deadline')}<input
                type="date"
                value={localDateInput(draft.config.selectionDeadline)}
                onchange={(event) => {
                  draft!.config.selectionDeadline = endOfLocalDayIso(event.currentTarget.value);
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
            >{$t('frameleaf_photography_client_terms')}<textarea
              maxlength="4000"
              rows="4"
              bind:value={draft.config.terms}></textarea></label
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
        <section class="phd-card phx-protection">
          <h3>{$t('frameleaf_photography_protection_title')}</h3>
          <label
            >{$t('frameleaf_photography_gallery_expiry')}<input
              type="date"
              value={localDateInput(draft.config.expiresAt)}
              onchange={(event) => {
                draft!.config.expiresAt = endOfLocalDayIso(event.currentTarget.value);
              }}
            /></label
          >
          <div class="phx-protection-part">
            <h4>{$t('frameleaf_photography_proof_protection')}</h4>
            <p>{$t('frameleaf_photography_proof_protection_body')}</p>
            <details>
              <summary>{$t('frameleaf_photography_adjust_watermark')}</summary>
              <PhotographyWatermarkEditor bind:value={draft.config.proofWatermark} disabled={busy} />
            </details>
          </div>
          <div class="phx-protection-part">
            <h4>{$t('frameleaf_photography_web_previews')}</h4>
            <label
              ><input
                type="checkbox"
                checked={draft.config.webWatermark !== null}
                onchange={(event) =>
                  (draft!.config.webWatermark = event.currentTarget.checked
                    ? structuredClone($state.snapshot(draft!.config.proofWatermark))
                    : null)}
              />{$t('frameleaf_photography_web_watermark_toggle')}</label
            >{#if draft.config.webWatermark}<details>
                <summary>{$t('frameleaf_photography_adjust_watermark')}</summary>
                <PhotographyWatermarkEditor bind:value={draft.config.webWatermark} disabled={busy} />
              </details>{/if}
          </div>
          <div class="phx-protection-part">
            <h4>{$t('frameleaf_photography_final_downloads')}</h4>
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
            >{#if draft.config.downloadWatermark}<details>
                <summary>{$t('frameleaf_photography_adjust_watermark')}</summary>
                <PhotographyWatermarkEditor bind:value={draft.config.downloadWatermark} disabled={busy} />
              </details>{/if}
          </div>
          {#if onWatermarks}<Button onclick={onWatermarks}
              ><Icon icon={mdiBrushOutline} size="1.1rem" aria-hidden={true} />{$t(
                'frameleaf_photography_design_watermark',
              )}</Button
            >{/if}
          <ol class="phx-flow-strip" aria-label={$t('frameleaf_photography_flow_label')}>
            {#each flowSteps[draft.config.mode] as step, index (step)}<li>
                {#if index > 0}<Icon icon={mdiChevronRight} size="0.875rem" aria-hidden={true} />{/if}{$t(step)}
              </li>{/each}
          </ol>
        </section>
      </div>
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
      <section class="phd-card">
        <div class="phd-row">
          <div>
            <h3>{$t('frameleaf_photography_ready_to_share')}</h3>
            <p>{$t('frameleaf_photography_ready_to_share_body')}</p>
          </div>
          <Button
            variant="primary"
            disabled={busy || eligible.length === 0}
            onclick={async () => {
              await mutate('/config', 'PUT', { config: draft!.config });
              if (!error) {
                await mutate('/publish', 'POST', { scope: 'all-eligible' });
              }
            }}>{$t('frameleaf_photography_prepare_proof_gallery')}</Button
          >
        </div>
        <label
          >{$t('frameleaf_photography_welcome_message')}<textarea
            maxlength="2000"
            rows="3"
            placeholder={$t('frameleaf_photography_welcome_placeholder')}
            value={draft.config.welcomeMessage ?? ''}
            oninput={(event) => (draft!.config.welcomeMessage = event.currentTarget.value)}></textarea></label
        >
        <label
          ><input
            type="checkbox"
            checked={draft.config.selfieSearch ?? false}
            onchange={(event) => (draft!.config.selfieSearch = event.currentTarget.checked)}
          />{$t('frameleaf_clients_selfie_enable')}</label
        >
        <label
          ><input
            type="checkbox"
            checked={draft.config.reminders?.selection ?? false}
            onchange={(event) =>
              (draft!.config.reminders = {
                paymentAndExpiry: draft!.config.reminders?.paymentAndExpiry ?? false,
                selection: event.currentTarget.checked,
              })}
          />{$t('frameleaf_photography_selection_reminder')}</label
        ><label
          ><input
            type="checkbox"
            checked={draft.config.reminders?.paymentAndExpiry ?? false}
            onchange={(event) =>
              (draft!.config.reminders = {
                selection: draft!.config.reminders?.selection ?? false,
                paymentAndExpiry: event.currentTarget.checked,
              })}
          />{$t('frameleaf_photography_payment_expiry_reminders')}</label
        >
        <p><small>{$t('frameleaf_photography_reminders_hint')}</small></p>
        {#if onGalleries}<Button onclick={onGalleries}
            ><Icon icon={mdiShieldLockOutline} size="1.1rem" aria-hidden={true} />{$t(
              'frameleaf_photography_invitations_link',
            )}</Button
          >{/if}
      </section>
      <div class="phd-actions">
        <Button variant="primary" disabled={busy} onclick={() => mutate('/config', 'PUT', { config: draft!.config })}
          >{$t('frameleaf_photography_save_workflow')}</Button
        >
      </div>
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
    {:else if panel === 'presentation'}
      <!-- PhotographyWorkflow.jsx templates: a starting point, then cover & pacing beside identity. -->
      <section class="phd-card">
        <span class="phx-eyebrow">{$t('frameleaf_photography_presentation_eyebrow')}</span>
        <h3>{$t('frameleaf_photography_presentation_title')}</h3>
        <p>{$t('frameleaf_photography_presentation_body')}</p>
        <div class="phd-templates">
          {#each [{ id: 'wedding', title: $t('frameleaf_photography_template_wedding'), detail: $t('frameleaf_photography_template_wedding_detail') }, { id: 'portrait', title: $t('frameleaf_photography_template_portrait'), detail: $t('frameleaf_photography_template_portrait_detail') }, { id: 'fine-art', title: $t('frameleaf_photography_template_fine_art'), detail: $t('frameleaf_photography_template_fine_art_detail') }, { id: 'proofing', title: $t('frameleaf_photography_template_proofing'), detail: $t('frameleaf_photography_template_proofing_detail') }] as template (template.id)}<button
              type="button"
              class:selected={draft.config.presentation.template === template.id}
              aria-pressed={draft.config.presentation.template === template.id}
              onclick={() =>
                (draft!.config.presentation.template = template.id as Workflow['config']['presentation']['template'])}
              ><span
                class="phd-template-cover {template.id}"
                style:background={coverPaper.background}
                style:color={coverPaper.text}
                aria-hidden="true"
                ><small>{brand?.brand.name ?? ''}</small><span class="phd-cover-photo"
                  >{#if coverAsset}<PhotographyThumb src={mediaUrl(coverAsset)} />{/if}</span
                ><span class="phd-cover-title">{template.id === 'wedding' ? shoot.name : template.title}</span><span
                  class="phd-cover-thumbs"
                  >{#each coverThumbs as id, index (index)}<span
                      >{#if id}<PhotographyThumb src={mediaUrl(id)} />{/if}</span
                    >{/each}</span
                ></span
              ><strong>{template.title}</strong><span>{template.detail}</span
              >{#if draft.config.presentation.template === template.id}<small
                  ><Icon icon={mdiCheck} size="0.875rem" aria-hidden={true} />{$t(
                    'frameleaf_photography_presentation_current',
                  )}</small
                >{/if}</button
            >{/each}
        </div>
      </section>
      <div class="phx-two-column phx-presentation">
        <section class="phd-card">
          <h3>{$t('frameleaf_photography_cover_pacing')}</h3>
          <label
            >{$t('frameleaf_photography_cover_photograph')}<select bind:value={draft.config.presentation.coverCaptureId}
              ><option value={null}>{$t('frameleaf_photography_cover_first')}</option
              >{#each eligible as capture (capture.id)}<option value={capture.id}
                  >{photoLabel(capture.number)} · {capture.fileName}</option
                >{/each}</select
            ></label
          >
          <div class="phd-fields">
            <label
              >{$t('frameleaf_photography_cover_treatment')}<select
                bind:value={draft.config.presentation.coverTreatment}
                ><option value="full">{$t('frameleaf_photography_block_full')}</option><option value="split"
                  >{$t('frameleaf_photography_cover_split')}</option
                ><option value="quiet">{$t('frameleaf_photography_cover_quiet')}</option></select
              ></label
            ><label
              >{$t('frameleaf_photography_spacing')}<select bind:value={draft.config.presentation.spacing}
                ><option value="compact">{$t('frameleaf_photography_spacing_compact')}</option><option
                  value="comfortable">{$t('frameleaf_photography_spacing_comfortable')}</option
                ><option value="airy">{$t('frameleaf_photography_spacing_airy')}</option></select
              ></label
            >
          </div>
          <label
            >{$t('frameleaf_photography_cover_focal')}<input
              type="range"
              min="0"
              max="100"
              bind:value={draft.config.presentation.coverFocal}
            /></label
          ><label
            >{$t('frameleaf_photography_introduction')}<textarea
              maxlength="2000"
              rows="3"
              bind:value={draft.config.presentation.introduction}></textarea></label
          >
        </section>
        <section class="phd-card">
          <h3>{$t('frameleaf_photography_identity_finishing')}</h3>
          <label
            >{$t('frameleaf_photography_gallery_typography')}<select bind:value={draft.config.presentation.font}
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
          ><label class="phx-check-row"
            ><span>{$t('frameleaf_photography_chapter_navigation')}</span><input
              type="checkbox"
              bind:checked={draft.config.presentation.showChapters}
            /></label
          ><label class="phx-check-row"
            ><span
              >{$t('frameleaf_photography_photo_numbers')}<small>{$t('frameleaf_photography_photo_numbers_hint')}</small
              ></span
            ><input type="checkbox" bind:checked={draft.config.presentation.showNumbers} /></label
          >
        </section>
      </div>
      <section class="phd-card">
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
      <!-- PhotographyWorkflow.jsx orders header: where things stand, and the running total by currency. -->
      <div class="phx-order-header">
        <div>
          <span class="phx-eyebrow">{$t('frameleaf_photography_orders_eyebrow')}</span>
          <h3>
            {draft.rounds.length > 0
              ? $t('frameleaf_photography_orders_rounds', { values: { count: draft.rounds.length } })
              : $t('frameleaf_photography_orders_waiting')}
          </h3>
          {#if draft.rounds.length === 0}<p>{$t('frameleaf_photography_orders_waiting_lead')}</p>{/if}
        </div>
        <p class="phd-order-total">
          <small>{$t('frameleaf_photography_order_total_so_far')}</small
          >{#each orderTotals as [currency, total] (currency)}<strong>{money(total, currency)}</strong>{:else}<strong
              >{money(0)}</strong
            >{/each}
        </p>
      </div>
      {#if draft.rounds.length === 0}<section class="phd-card phx-orders-empty">
          <Icon icon={mdiHeartOutline} size="2.6rem" aria-hidden={true} />
          <h3>{$t('frameleaf_photography_orders_empty_title')}</h3>
          <p>{$t('frameleaf_photography_orders_empty_body')}</p>
          <div class="phd-actions">
            <Button variant="primary" disabled={previewing} onclick={clientPreview}
              ><Icon icon={mdiEyeOutline} size="1.1rem" aria-hidden={true} />{$t(
                'frameleaf_photography_open_client_preview',
              )}</Button
            >{#if onSection}<Button onclick={() => onSection('workflow')}
                >{$t('frameleaf_photography_configure_package')}</Button
              >{/if}
          </div>
        </section>{/if}
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
              <strong>{recipient(order.recipientId)}</strong><span>{named('order', order.status)}</span>
              <!-- The amount says what it is (approved design, 2026-11-04). -->
              <p class="phd-order-total">
                <small>{$t('frameleaf_photography_order_total')}</small><strong
                  >{money(order.total, order.currency)}</strong
                >
              </p>
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
      <!-- PhotographyWorkspace.jsx Gallery (approved design, 2026-11-04): what the client sees on the
           left, the gallery's settings on the right. -->
      <div class="phw-gallery-tools">
        <span>{$t('frameleaf_photography_proof_photo_count', { values: { count: eligible.length } })}</span>
        <span class="phw-status" class:is-expired={galleryExpired}>{galleryStage}</span>
      </div>
      <div class="phw-detail-layout phx-gallery">
        <div class="phw-gallery-main">
          <figure class="phw-gallery-cover" class:is-empty={!galleryCoverUrl}>
            {#if galleryCoverUrl}<PhotographyThumb src={galleryCoverUrl} loading="eager" /><span
                class="phx-cover-mark"
                aria-hidden="true">{draft.config.proofWatermark.text || brand?.brand.name || ''}</span
              >{:else}<!-- No cover preview yet: a quiet empty cover, never a broken image under the watermark. --><span
                class="phw-gallery-cover-empty"
                aria-hidden="true"><Icon icon={mdiImageOutline} size="2.5rem" /></span
              >{/if}
            <figcaption class="phw-gallery-cover-text">
              <span>{brand?.brand.name ?? ''}</span>
              <h2>{draft.config.title || shoot.name}</h2>
              <p>{$t('frameleaf_photography_gallery_first_look')}</p>
            </figcaption>
          </figure>
          <ul class="phw-gallery-summary">
            <li>
              <Icon icon={mdiLockOutline} size="1rem" aria-hidden={true} />{activeRecipients.some(
                (row) => row.passwordProtected,
              )
                ? $t('frameleaf_photography_gallery_password_on')
                : $t('frameleaf_photography_gallery_link_only')}
            </li>
            <li>
              <Icon icon={mdiDownloadOutline} size="1rem" aria-hidden={true} />{activeRecipients.some(
                (row) => row.canDownload,
              )
                ? $t('frameleaf_photography_downloads_on')
                : $t('frameleaf_photography_downloads_off')}
            </li>
            <li>
              <Icon icon={mdiShieldCheckOutline} size="1rem" aria-hidden={true} />{$t(
                'frameleaf_photography_gallery_watermark_on',
              )}
            </li>
          </ul>
          <div class="phw-section-heading">
            <div>
              <h3>{$t('frameleaf_photography_client_selections')}</h3>
              <p>
                {draft.config.maxSelections
                  ? $t('frameleaf_photography_selected_of', {
                      values: { count: clientChoices.length, limit: draft.config.maxSelections },
                    })
                  : $t('frameleaf_photography_selected_count', { values: { count: clientChoices.length } })}{draft
                  .rounds.length > 0
                  ? ` · ${$t('frameleaf_photography_selection_sent')}`
                  : ''}
              </p>
            </div>
            <Button disabled={previewing || !stored} onclick={clientPreview}
              ><Icon icon={mdiAccountOutline} size="1rem" aria-hidden={true} />{$t(
                'frameleaf_photography_try_as_client',
              )}</Button
            >
          </div>
          <ul class="phw-client-picks">
            {#each clientChoices.length > 0 ? clientChoices.slice(0, 6) : eligible.slice(0, 3) as capture (capture.id)}
              <li>
                <PhotographyThumb
                  src={mediaUrl(capture.assetId)}
                  alt={capture.fileName ?? photoLabel(capture.number)}
                />
                <span
                  ><Icon
                    icon={clientChoices.length > 0 ? mdiHeart : mdiHeartOutline}
                    size="0.875rem"
                    aria-hidden={true}
                  />{capture.fileName ?? photoLabel(capture.number)}</span
                >
              </li>
            {/each}
          </ul>
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
            <h3>{$t('frameleaf_photography_recipient_access')}</h3>
            {#each draft.recipients as row (row.id)}<div class="phd-order">
                <div class="phd-row">
                  <strong
                    >{row.name}{#if row.email}<small> · {row.email}</small>{/if}</strong
                  ><span
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
        </div>
        <aside class="phw-inspector" aria-labelledby="phx-gallery-settings">
          <div class="phw-inspector-body">
            <h2 id="phx-gallery-settings">{$t('frameleaf_photography_gallery_settings')}</h2>
            <h3>{$t('frameleaf_photography_invite_title')}</h3>
            <p>{$t('frameleaf_photography_invite_body')}</p>
            <div class="phd-fields">
              <label
                >{$t('frameleaf_photography_recipient_name')}<input maxlength="100" bind:value={recipientName} /></label
              ><label
                >{$t('frameleaf_photography_recipient_email')}<input
                  type="email"
                  autocomplete="off"
                  maxlength="254"
                  placeholder={$t('frameleaf_photography_recipient_email_placeholder')}
                  bind:value={recipientEmail}
                /></label
              ><label
                >{$t('frameleaf_photography_gallery_password_optional')}<input
                  type="password"
                  autocomplete="new-password"
                  minlength="8"
                  maxlength="72"
                  bind:value={recipientPassword}
                /></label
              ><label
                >{$t('frameleaf_photography_invitation_expiry')}<input
                  type="date"
                  bind:value={recipientExpiry}
                /></label
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
                (recipientPassword.length > 0 && recipientPassword.length < 8) ||
                (recipientEmail.trim().length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail.trim()))}
              onclick={() =>
                mutate('/recipients', 'POST', {
                  name: recipientName.trim(),
                  ...(recipientEmail.trim() && { email: recipientEmail.trim() }),
                  password: recipientPassword || null,
                  expiresAt: endOfLocalDayIso(recipientExpiry),
                  canProof: true,
                  canDownload: recipientDownload,
                  captureIds: restrictInvitation ? selected : null,
                })}>{$t('frameleaf_photography_create_invitation')}</Button
            >{#if invitation}<label
                >{$t('frameleaf_photography_invitation_once')}<input readonly value={invitation} /></label
              ><Button onclick={copyInvitation}>{$t('frameleaf_photography_copy_invitation')}</Button>{/if}

            <h3>{$t('frameleaf_photography_gallery_wide')}</h3>
            <label
              >{$t('frameleaf_photography_gallery_expiry')}<input
                type="date"
                value={localDateInput(draft.config.expiresAt)}
                onchange={(event) => {
                  draft!.config.expiresAt = endOfLocalDayIso(event.currentTarget.value);
                }}
              /></label
            ><label
              >{$t('frameleaf_photography_selection_limit')}<input
                type="number"
                min="1"
                max="10000"
                step="1"
                value={draft.config.maxSelections ?? ''}
                placeholder={$t('frameleaf_photography_no_limit')}
                onchange={(event) => {
                  draft!.config.maxSelections =
                    event.currentTarget.value === ''
                      ? null
                      : Math.max(1, Math.min(10_000, Math.round(event.currentTarget.valueAsNumber)));
                }}
              /></label
            >
            <Button
              disabled={busy || !gallerySettingsChanged}
              onclick={() => mutate('/config', 'PUT', { config: draft!.config })}
              >{$t('frameleaf_photography_save_gallery_settings')}</Button
            >
            <Button disabled={previewing || !stored} onclick={clientPreview}
              ><Icon icon={mdiEyeOutline} size="1rem" aria-hidden={true} />{$t(
                'frameleaf_photography_open_client_preview',
              )}</Button
            >{#if onSection}<Button onclick={() => onSection('photos')}
                ><Icon icon={mdiCameraOutline} size="1rem" aria-hidden={true} />{$t(
                  'frameleaf_photography_edit_proof_selection',
                )}</Button
              >{/if}
            <p class="phw-small">
              {draft.config.proofCollection === 'selected'
                ? $t('frameleaf_photography_gallery_scope_selected')
                : $t('frameleaf_photography_gallery_scope_all')}
            </p>
          </div>
        </aside>
      </div>
    {/if}
  {/if}
</div>
