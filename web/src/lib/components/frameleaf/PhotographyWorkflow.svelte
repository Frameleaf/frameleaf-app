<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { AssetMediaSize, getAssetDevelop } from '@immich/sdk';
  import Button from './Button.svelte';
  import PhotographyWatermarkEditor from './PhotographyWatermarkEditor.svelte';
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
  const money = (amount: number, currency = draft?.config.currency ?? 'CAD') => {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100);
    } catch {
      return `${amount / 100} ${currency}`;
    }
  };
  const photoUrl = (capture: Capture) =>
    capture.eligible && capture.assetId
      ? getAssetMediaUrl({ id: capture.assetId, size: AssetMediaSize.Thumbnail })
      : '';
  const describe = (cause: unknown) =>
    cause instanceof Error ? cause.message : 'The request could not be completed. Try again.';
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
        label: 'Full resolution',
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
      label: kind === 'print' ? 'Print version' : kind === 'web' ? 'Web size' : 'Social size',
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
      message = 'Studio preset saved for all projects.';
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
      message = 'Saved';
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
      title: `Chapter ${draft.chapters.length + 1}`,
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
        .map((revision) => ({ id: revision.id, label: revision.label || `Version ${revision.revision}` }));
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
      ['Photo', 'File', 'Camera', 'Photographer', 'Chapter', 'Selected', 'Approved revision'],
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
      message = 'Invitation copied';
    } catch {
      error = 'Select and copy the invitation below.';
    }
  }
  const recipient = (id: string) => stored?.recipients.find((row) => row.id === id)?.name ?? 'Recipient';
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
      <span class="phd-eyebrow">{shoot.type} · {shoot.client}</span>
      <h2>
        {panel === 'intake'
          ? 'Intake & assembly'
          : panel === 'workflow'
            ? 'Client workflow'
            : panel === 'orders'
              ? 'Selections, orders & delivery'
              : panel === 'presentation'
                ? 'Gallery presentation'
                : 'Publishing'}
      </h2>
    </div>
    <Button disabled={busy} onclick={reload}>Refresh</Button>
  </div>
  {#if error}<div class="phw-notice" role="alert">
      {error}<Button disabled={busy} onclick={reload}>Reload</Button>
    </div>{/if}
  {#if message}<p class="phd-status" role="status">{message}</p>{/if}
  {#if !draft}<div class="phw-empty" role="status">
      {busy ? 'Loading project…' : 'Open the project again to retry.'}
    </div>
  {:else if shoot.unavailable}<div class="phw-empty">
      The source album is unavailable. Restore access before continuing.
    </div>
  {:else}
    <div class="phd-metrics">
      <div><strong>{draft.captures.length}</strong><span>Captures</span></div>
      <div><strong>{eligible.length}</strong><span>Available proofs</span></div>
      <div><strong>{draft.rounds.length}</strong><span>Selection rounds</span></div>
      <div>
        <strong>{draft.orders.filter((order) => order.status === 'settled').length}</strong><span>Settled orders</span>
      </div>
    </div>
    {#if panel === 'intake'}
      <section class="phd-card">
        <div class="phd-row">
          <div>
            <h3>Bring the shoot together</h3>
            <p>
              Import files or a folder into this project’s album, then refresh capture records. Existing stacks retain
              RAW and JPEG pairs.
            </p>
          </div>
          <div class="phd-actions">
            <Button disabled={busy || !shoot.albumId} onclick={() => intake()}>Import files</Button><Button
              disabled={busy || !shoot.albumId}
              onclick={() => intake(true)}>Import folder</Button
            ><Button variant="primary" disabled={busy} onclick={() => mutate('/intake')}>Scan album</Button>
          </div>
        </div>
      </section>
      <section class="phd-card">
        <div class="phd-row">
          <div>
            <h3>Chapters & sequence</h3>
            <p>Stable photo numbers follow captures through selection and delivery.</p>
          </div>
          <Button disabled={busy} onclick={addChapter}>Add chapter</Button>
        </div>
        {#each draft.chapters as chapter (chapter.id)}<div class="phd-chapter">
            <label>Chapter name<input maxlength="100" bind:value={chapter.title} /></label><label
              >Description<input maxlength="1000" bind:value={chapter.description} /></label
            ><label
              >Cover<select bind:value={chapter.coverCaptureId}
                ><option value={null}>Automatic</option>{#each eligible as capture (capture.id)}<option
                    value={capture.id}>Photo {capture.number}</option
                  >{/each}</select
              ></label
            ><label>Order<input type="number" min="0" step="1" bind:value={chapter.position} /></label>
          </div>{/each}
        <div class="phd-row">
          <label
            >Sequence<select bind:value={ordering}
              ><option value="chronological">Capture time</option><option value="photographer">Photographer</option
              ><option value="manual">Manual order</option><option value="chapters">Chapters</option></select
            ></label
          ><Button variant="primary" disabled={busy} onclick={assemble}>Save assembly</Button>
        </div>
      </section>
      <div class="phd-row">
        <label>Find a capture<input placeholder="Photo number, file or camera" bind:value={query} /></label><label
          >Show<select bind:value={filter}
            ><option value="all">All captures</option><option value="raw">RAW</option><option value="rated"
              >Rated 4–5 stars</option
            ><option value="rejected">Rejected</option><option value="editing">Awaiting editing</option><option
              value="delivery">Ready for delivery</option
            ><option value="chosen">Client selections</option><option value="issues">Needs attention</option><option
              value="withheld">Withheld</option
            ></select
          ></label
        ><span>{filtered.length} captures</span>
      </div>
      <div class="phd-card">
        <h3>Assemble selected captures</h3>
        <p>Apply only the fields you choose. Camera clock corrections preserve the original capture time.</p>
        <div class="phd-fields">
          <label
            ><input type="checkbox" bind:checked={applyCredit} />Set photographer credit<input
              maxlength="100"
              disabled={!applyCredit}
              bind:value={teamName}
            /></label
          >
          <label
            ><input type="checkbox" bind:checked={applyClock} />Correct camera clock (seconds)<input
              type="number"
              min="-86400"
              max="86400"
              step="1"
              disabled={!applyClock}
              bind:value={clockOffset}
            /></label
          >
          <label
            >Chapter<select bind:value={assemblyChapter}
              ><option value="__unchanged">Keep existing chapters</option><option value="">Unassigned</option
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
            }}>Select available captures in this view</Button
          ><Button
            disabled={busy || selected.length === 0}
            onclick={() => {
              selected = [];
            }}>Clear selection</Button
          ><Button
            disabled={busy ||
              selected.length === 0 ||
              (!applyCredit && !applyClock && assemblyChapter === '__unchanged')}
            onclick={applyAssembly}>Apply to {selected.length} captures</Button
          ><Button disabled={busy} onclick={assemble}>Save assembly</Button>
        </div>
      </div>
      <div class="phd-captures">
        {#each filtered.slice(0, limit) as capture (capture.id)}<article class="phd-capture">
            <div class="phd-capture-image">
              {#if photoUrl(capture)}<img
                  src={photoUrl(capture)}
                  alt={capture.fileName ?? 'Photograph'}
                  loading="lazy"
                />{:else}<span>{capture.exclusion ?? 'Preview unavailable'}</span>{/if}
            </div>
            <div>
              <strong>Photo {capture.number}</strong><label
                ><input
                  type="checkbox"
                  disabled={!capture.eligible || busy}
                  checked={selected.includes(capture.id)}
                  onchange={(event) =>
                    (selected = event.currentTarget.checked
                      ? [...selected, capture.id]
                      : selected.filter((id) => id !== capture.id))}
                />Select for assembly</label
              ><small>{capture.fileName || 'Unavailable capture'}</small><small
                >{capture.camera ?? 'Camera metadata unavailable'} · {capture.isRaw ? 'RAW' : 'Image'}{capture.assetIds
                  .length > 1
                  ? ` · ${capture.assetIds.length} stacked files`
                  : ''}</small
              ><small>{capture.processing}{capture.exclusion ? ` · ${capture.exclusion}` : ''}</small
              >{#if capture.checksum}<details>
                  <summary>Import checksum</summary><code class="phd-checksum">{capture.checksum}</code>
                </details>{/if}<label
                >Photographer<input
                  disabled={!capture.eligible || busy}
                  maxlength="100"
                  bind:value={capture.photographer}
                /></label
              >
              <div class="phd-fields">
                <label
                  >Clock correction (seconds)<input
                    disabled={!capture.eligible || busy}
                    type="number"
                    step="1"
                    min="-86400"
                    max="86400"
                    bind:value={capture.offsetSeconds}
                  /></label
                ><label
                  >Chapter<select disabled={busy} bind:value={capture.chapterId}
                    ><option value={null}>Unassigned</option>{#each draft.chapters as chapter (chapter.id)}<option
                        value={chapter.id}>{chapter.title}</option
                      >{/each}</select
                  ></label
                >
              </div>
              <div class="phd-actions">
                {#if capture.eligible && capture.processing !== 'ready'}<Button
                    disabled={busy}
                    onclick={() => mutate(`/captures/${capture.id}/retry-processing`)}>Retry preview processing</Button
                  >{/if}
                {#if capture.eligible && capture.assetIds.length > 1}<Button
                    disabled={busy}
                    onclick={() => mutate('/intake', 'POST', { expandCaptureIds: [capture.id] })}
                    >Split paired files</Button
                  >{/if}
                <label><input type="checkbox" disabled={busy} bind:checked={capture.withheld} />Withhold</label><Button
                  disabled={busy}
                  label={`Move photo ${capture.number} earlier`}
                  onclick={() => move(capture.id, -1)}>↑</Button
                ><Button
                  disabled={busy}
                  label={`Move photo ${capture.number} later`}
                  onclick={() => move(capture.id, 1)}>↓</Button
                >{#if capture.eligible && capture.assetId && shoot.albumId}<a
                    href={Route.viewAlbumAsset({ albumId: shoot.albumId, assetId: capture.assetId })}>Open editor</a
                  >{/if}
              </div>
            </div>
          </article>{/each}
      </div>
      {#if filtered.length > limit}<Button onclick={() => (limit += 80)}>Show more captures</Button>{/if}
    {:else if panel === 'workflow'}
      <section class="phd-card">
        <h3>Studio workflow presets</h3>
        <p>
          Reuse package prices, presentation and watermark settings across projects. Existing orders and published
          collections keep their saved settings.
        </p>
        <div class="phd-row">
          <label>Preset name<input maxlength="100" bind:value={presetName} /></label><Button
            disabled={busy || !presetName.trim() || (draft.studioPresets?.presets.length ?? 0) >= 30}
            onclick={() => saveStudioPreset()}>Save studio preset</Button
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
                  })}>Apply to this draft</Button
              ><Button disabled={busy || !presetName.trim()} onclick={() => saveStudioPreset(preset.id)}
                >Replace with draft settings</Button
              >
            </div>
          </div>{:else}<p>No studio presets saved yet.</p>{/each}
        <details>
          <summary>Project snapshots</summary><Button
            disabled={busy || !presetName.trim() || draft.presets.length >= 30}
            onclick={() => mutate('/presets', 'POST', { id: null, name: presetName.trim(), config: draft!.config })}
            >Save snapshot in this project</Button
          >{#each draft.presets as preset (preset.id)}<div class="phd-row">
              <span>{preset.name}</span><Button disabled={busy} onclick={() => mutate(`/presets/${preset.id}/apply`)}
                >Restore draft snapshot</Button
              >
            </div>{/each}
        </details>
      </section>
      <section class="phd-card">
        <h3>The client’s journey</h3>
        <div class="phd-fields">
          <label>Collection title<input maxlength="200" bind:value={draft.config.title} /></label><label
            >Workflow<select bind:value={draft.config.mode}
              ><option value="edited-delivery">Edited delivery</option><option value="select-before-editing"
                >Select before editing</option
              ><option value="sell-by-photo">Sell by photo</option></select
            ></label
          ><label
            >Payment<select bind:value={draft.config.paymentTiming}
              ><option value="before-editing">Before editing</option><option value="after-approval"
                >After approval</option
              ></select
            ></label
          ><label>Currency<input maxlength="3" bind:value={draft.config.currency} /></label><label
            >Included photographs<input type="number" min="0" step="1" bind:value={draft.config.includedCount} /></label
          ><label
            >Additional photo price<input
              type="number"
              min="0"
              step="0.01"
              value={draft.config.additionalPrice / 100}
              onchange={(event) => {
                draft!.config.additionalPrice = Math.round(event.currentTarget.valueAsNumber * 100);
              }}
            /></label
          ><label
            >Full collection price<input
              type="number"
              min="0"
              step="0.01"
              value={draft.config.collectionPrice === null ? '' : draft.config.collectionPrice / 100}
              onchange={(event) => {
                draft!.config.collectionPrice =
                  event.currentTarget.value === '' ? null : Math.round(event.currentTarget.valueAsNumber * 100);
              }}
              placeholder="Not offered"
            /></label
          ><label
            >Turnaround (days)<input
              type="number"
              min="0"
              max="365"
              step="1"
              bind:value={draft.config.turnaroundDays}
            /></label
          ><label
            >Selection deadline<input
              type="date"
              value={draft.config.selectionDeadline?.slice(0, 10) ?? ''}
              onchange={(event) => {
                draft!.config.selectionDeadline = event.currentTarget.value
                  ? new Date(`${event.currentTarget.value}T23:59:59`).toISOString()
                  : null;
              }}
            /></label
          ><label
            >Gallery expiry<input
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
        <p>Additional photo: {money(draft.config.additionalPrice)}. Prices are frozen when you confirm an order.</p>
        <label>Client terms<textarea maxlength="4000" rows="4" bind:value={draft.config.terms}></textarea></label>
        <div class="phd-row">
          <h4>Photo bundles</h4>
          <Button
            disabled={busy || draft.config.bundles.length >= 20}
            onclick={() => {
              draft!.config.bundles.push({ count: 5, price: 0 });
            }}>Add bundle</Button
          >
        </div>
        {#each draft.config.bundles as bundle, index (index)}<div class="phd-fields">
            <label>Photographs<input type="number" min="1" step="1" bind:value={bundle.count} /></label><label
              >Bundle price<input
                type="number"
                min="0"
                step="0.01"
                value={bundle.price / 100}
                onchange={(event) => {
                  bundle.price = Math.round(event.currentTarget.valueAsNumber * 100);
                }}
              /></label
            ><Button onclick={() => draft!.config.bundles.splice(index, 1)}>Remove bundle</Button>
          </div>{/each}
      </section>
      <section class="phd-card">
        <h3>Proof protection</h3>
        <p>Selection proofs use this baked watermark on every web rendition, including thumbnails.</p>
        <PhotographyWatermarkEditor bind:value={draft.config.proofWatermark} disabled={busy} />
      </section>
      <section class="phd-card">
        <h3>Edited web previews</h3>
        <label
          ><input
            type="checkbox"
            checked={draft.config.webWatermark !== null}
            onchange={(event) =>
              (draft!.config.webWatermark = event.currentTarget.checked
                ? structuredClone($state.snapshot(draft!.config.proofWatermark))
                : null)}
          />Add a separate watermark to edited previews</label
        >{#if draft.config.webWatermark}<PhotographyWatermarkEditor
            bind:value={draft.config.webWatermark}
            disabled={busy}
          />{/if}
      </section>
      <section class="phd-card">
        <h3>Final downloads</h3>
        <p>
          Approved downloads contain the edited photograph. Add a mark here only when it should appear in the delivered
          file.
        </p>
        <label
          ><input
            type="checkbox"
            checked={draft.config.downloadWatermark !== null}
            onchange={(event) =>
              (draft!.config.downloadWatermark = event.currentTarget.checked
                ? structuredClone($state.snapshot(draft!.config.proofWatermark))
                : null)}
          />Watermark final exports</label
        >{#if draft.config.downloadWatermark}<PhotographyWatermarkEditor
            bind:value={draft.config.downloadWatermark}
            disabled={busy}
          />{/if}
      </section>
      <section class="phd-card">
        <h3>Download sizes & versions</h3>
        <p>
          Choose up to six files per photograph. Each order pins its sizes, approved revisions and branding. New choices
          affect future orders.
        </p>
        <div class="phd-actions">
          <Button disabled={busy || (draft.config.downloadOutputs?.length ?? 1) >= 6} onclick={() => addOutput('print')}
            >Add print version</Button
          ><Button disabled={busy || (draft.config.downloadOutputs?.length ?? 1) >= 6} onclick={() => addOutput('web')}
            >Add web size</Button
          ><Button
            disabled={busy || (draft.config.downloadOutputs?.length ?? 1) >= 6}
            onclick={() => addOutput('social')}>Add social size</Button
          >
        </div>
        {#each draft.config.downloadOutputs ?? [] as output, index (output.key)}<div class="phd-order">
            <div class="phd-fields">
              <label>File label<input maxlength="100" disabled={busy} bind:value={output.label} /></label><label
                >Size<select
                  disabled={busy}
                  bind:value={output.kind}
                  onchange={() => {
                    output.maxEdge = output.kind === 'print' ? 65_535 : 2048;
                  }}
                  ><option value="print">Full resolution</option><option value="web">Web</option><option value="social"
                    >Social</option
                  ></select
                ></label
              >{#if output.kind !== 'print'}<label
                  >Longest edge (pixels)<input
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
              />Include a watermark in this file</label
            >
            {#if output.watermark}<PhotographyWatermarkEditor bind:value={output.watermark} disabled={busy} />{:else}<p>
                Clean edited photograph
              </p>{/if}
            <Button
              disabled={busy || draft.config.downloadOutputs!.length === 1}
              onclick={() => {
                draft!.config.downloadOutputs!.splice(index, 1);
              }}>Remove file choice</Button
            >
          </div>{:else}<p>Full resolution JPEG using the final download settings above.</p>{/each}
        {#if draft.config.downloadOutputs}<Button
            disabled={busy}
            onclick={() => {
              delete draft!.config.downloadOutputs;
            }}>Use one full resolution file</Button
          >{/if}
      </section>
      {#if brand?.brand.watermarkPresets?.length}<section class="phd-card">
          <h3>Saved studio presets</h3>
          {#each brand.brand.watermarkPresets as preset (preset.id)}<div class="phd-row">
              <span>{preset.name} · v{preset.version}</span>
              <div class="phd-actions">
                <Button
                  disabled={busy}
                  onclick={() => (draft!.config.proofWatermark = structuredClone($state.snapshot(preset.watermark)))}
                  >Use for proofs</Button
                ><Button
                  disabled={busy}
                  onclick={() => (draft!.config.webWatermark = structuredClone($state.snapshot(preset.watermark)))}
                  >Use for web</Button
                ><Button
                  disabled={busy}
                  onclick={() => (draft!.config.downloadWatermark = structuredClone($state.snapshot(preset.watermark)))}
                  >Use for exports</Button
                >
              </div>
            </div>{/each}
        </section>{/if}
      <Button variant="primary" disabled={busy} onclick={() => mutate('/config', 'PUT', { config: draft!.config })}
        >Save client workflow</Button
      >
    {:else if panel === 'presentation'}
      <section class="phd-card">
        <h3>A presentation for this shoot</h3>
        <div class="phd-templates">
          {#each [{ id: 'wedding', title: 'Wedding journal', detail: 'Full cover, chapters and a generous narrative sequence.' }, { id: 'portrait', title: 'Family & portrait', detail: 'An inviting split cover and a flowing photo wall.' }, { id: 'fine-art', title: 'Editorial & fine art', detail: 'Quiet typography, ample space and individual frames.' }, { id: 'proofing', title: 'Proofing & sales', detail: 'A numbered contact sheet with selection and order tools.' }] as template (template.id)}<button
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
            >Cover photograph<select bind:value={draft.config.presentation.coverCaptureId}
              ><option value={null}>First published photograph</option>{#each eligible as capture (capture.id)}<option
                  value={capture.id}>Photo {capture.number} · {capture.fileName}</option
                >{/each}</select
            ></label
          ><label
            >Cover treatment<select bind:value={draft.config.presentation.coverTreatment}
              ><option value="full">Full photograph</option><option value="split">Split introduction</option><option
                value="quiet">Quiet title</option
              ></select
            ></label
          ><label
            >Cover focal point<input
              type="range"
              min="0"
              max="100"
              bind:value={draft.config.presentation.coverFocal}
            /></label
          ><label
            >Typography<select bind:value={draft.config.presentation.font}
              ><option value="editorial">Editorial serif</option><option value="modern">Modern sans</option><option
                value="script">Studio script</option
              ></select
            ></label
          ><label
            >Palette<select bind:value={draft.config.presentation.palette}
              ><option value="studio">Studio colours</option><option value="ivory">Ivory</option><option
                value="charcoal">Charcoal</option
              ></select
            ></label
          ><label
            >Spacing<select bind:value={draft.config.presentation.spacing}
              ><option value="compact">Compact</option><option value="comfortable">Comfortable</option><option
                value="airy">Airy</option
              ></select
            ></label
          >
        </div>
        <label
          >Introduction<textarea maxlength="2000" rows="4" bind:value={draft.config.presentation.introduction}
          ></textarea></label
        >
        <div class="phd-actions">
          <label
            ><input type="checkbox" bind:checked={draft.config.presentation.showChapters} />Chapter navigation</label
          ><label><input type="checkbox" bind:checked={draft.config.presentation.showNumbers} />Photo numbers</label>
        </div>
        <h3>Story blocks</h3>
        <p>
          Arrange chapters, photo groups, pairs, captions and slideshows within this template. Save and republish to
          update the client collection.
        </p>
        <div class="phd-actions">
          {#each ['chapter', 'grid', 'full', 'pair', 'caption', 'slideshow'] as type (type)}<Button
              disabled={busy || (draft.config.presentation.blocks?.length ?? 0) >= 100}
              onclick={() => addBlock(type as PresentationBlock['type'])}
              >Add {type === 'full' ? 'full photograph' : type === 'pair' ? 'photo pair' : type}</Button
            >{/each}
        </div>
        {#each draft.config.presentation.blocks ?? [] as block, index (block.id)}<div class="phd-order">
            <div class="phd-row">
              <strong>{index + 1}. {block.type}</strong>
              <div class="phd-actions">
                <Button
                  disabled={busy || index === 0}
                  label={`Move block ${index + 1} earlier`}
                  onclick={() => moveBlock(index, -1)}>↑</Button
                ><Button
                  disabled={busy || index === draft!.config.presentation.blocks!.length - 1}
                  label={`Move block ${index + 1} later`}
                  onclick={() => moveBlock(index, 1)}>↓</Button
                ><Button
                  disabled={busy}
                  onclick={() => {
                    draft!.config.presentation.blocks!.splice(index, 1);
                  }}>Remove block</Button
                >
              </div>
            </div>
            <div class="phd-fields">
              <label
                >Chapter<select disabled={busy} bind:value={block.chapterId}
                  ><option value={null}>All chapters</option>{#each draft.chapters as chapter (chapter.id)}<option
                      value={chapter.id}>{chapter.title}</option
                    >{/each}</select
                ></label
              ><label
                >{block.type === 'caption'
                  ? 'Caption'
                  : block.type === 'chapter'
                    ? 'Chapter introduction'
                    : 'Group caption'}<textarea maxlength="2000" rows="3" disabled={busy} bind:value={block.text}
                ></textarea></label
              >
            </div>
            {#if !['chapter', 'caption'].includes(block.type)}<details>
                <summary
                  >Photographs ({block.selection === 'explicit' || block.captureIds.length > 0
                    ? block.captureIds.length
                    : 'automatic'})</summary
                >
                <p>
                  Choose photographs in their display order, or use the assembled chapter sequence. Full photograph and
                  pair blocks show the first one or two matching photographs.
                </p>
                <Button
                  disabled={busy}
                  onclick={() => {
                    block.selection = 'automatic';
                    block.captureIds = [];
                  }}>Use assembled sequence</Button
                >
                {#each block.captureIds as id, photoIndex (id)}<div class="phd-row">
                    <span
                      >{photoIndex + 1}. Photo {eligible.find((capture) => capture.id === id)?.number ??
                        'unavailable'}</span
                    >
                    <div class="phd-actions">
                      <Button
                        disabled={busy || photoIndex === 0}
                        label={`Move selected photo ${photoIndex + 1} earlier`}
                        onclick={() => moveBlockPhoto(block, photoIndex, -1)}>↑</Button
                      >
                      <Button
                        disabled={busy || photoIndex === block.captureIds.length - 1}
                        label={`Move selected photo ${photoIndex + 1} later`}
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
                    />Photo {capture.number} · {capture.fileName}</label
                  >{/each}
              </details>{/if}
          </div>{:else}<p>This collection uses the template’s assembled photo sequence.</p>{/each}
        <p>Save the design, then publish to update the client collection.</p>
        <Button variant="primary" disabled={busy} onclick={() => mutate('/config', 'PUT', { config: draft!.config })}
          >Save presentation</Button
        >
      </section>
    {:else if panel === 'orders'}
      {#if draft.config.downloadOutputs?.length}<section class="phd-card">
          <h3>Versions for the next order</h3>
          <p>
            Leave a photograph on the normal approval workflow, or choose a previously approved version. These choices
            are frozen when you confirm an order.
          </p>
          {#each draft.config.downloadOutputs as output (output.key)}<details>
              <summary>{output.label}</summary
              >{#each eligible.filter( (capture) => draft!.approvedVersions?.some((version) => version.captureId === capture.id) ) as capture (capture.id)}<label
                  >Photo {capture.number}<select
                    value={outputVersions[output.key]?.[capture.id] ?? ''}
                    onchange={(event) => {
                      outputVersions[output.key] ??= {};
                      outputVersions[output.key][capture.id] = event.currentTarget.value;
                    }}
                    ><option value="">Normal approval workflow</option
                    >{#each draft.approvedVersions?.filter((version) => version.captureId === capture.id) ?? [] as version (version.revisionId)}<option
                        value={version.revisionId}
                        >{versionChoices[capture.id]?.find((choice) => choice.id === version.revisionId)?.label ??
                          `Approved ${new Date(version.approvedAt).toLocaleString()}`}</option
                      >{/each}</select
                  ></label
                ><Button disabled={busy} onclick={() => revisions(capture)}>Load version names</Button>{:else}<p>
                  No approved versions yet.
                </p>{/each}
            </details>{/each}
        </section>{/if}

      {#if draft.config.mode === 'edited-delivery'}<section class="phd-card">
          <h3>Edited delivery</h3>
          <p>
            Confirm an included collection for a recipient. Approved versions and download permissions still control
            release.
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
                  })}>Confirm delivery order</Button
              >
            </div>{:else}<p>Invite a recipient in Publishing first.</p>{/each}
        </section>{/if}
      <section class="phd-card">
        <div class="phd-row">
          <div>
            <h3>Selection rounds</h3>
            <p>
              Submitted selections are retained as separate rounds. Confirm an immutable order before editing or
              delivering.
            </p>
          </div>
          <Button disabled={!stored?.rounds.length} onclick={csv}>Export selection CSV</Button>
        </div>
        {#each draft.rounds as round (round.id)}<article class="phd-order">
            <div class="phd-row">
              <strong>{recipient(round.recipientId)} · {new Date(round.createdAt).toLocaleString()}</strong><span
                >{round.captureIds.length} photographs</span
              >
            </div>
            <p>
              {round.captureIds
                .map((id) => `#${draft?.captures.find((capture) => capture.id === id)?.number ?? '—'}`)
                .join(' · ')}
            </p>
            {#each round.notes as note, index (index)}<p>
                Photo {draft.captures.find((capture) => capture.id === note.captureId)?.number}: {note.text}{#each note.annotations ?? [] as annotation, annotationIndex (annotationIndex)}<small
                    >Area {annotationIndex + 1}: {annotation.text}</small
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
                  })}>Confirm package order</Button
              >{#if draft.config.collectionPrice !== null}<Button
                  disabled={busy}
                  onclick={() =>
                    mutate('/orders', 'POST', {
                      roundId: round.id,
                      recipientId: round.recipientId,
                      pricing: 'collection',
                      outputs: orderOutputs(eligible.map((capture) => capture.id)),
                    })}>Confirm full collection</Button
                >{/if}{#each draft.config.bundles as bundle, index (index)}<Button
                  disabled={busy || round.captureIds.length > bundle.count}
                  onclick={() =>
                    mutate('/orders', 'POST', {
                      roundId: round.id,
                      recipientId: round.recipientId,
                      pricing: 'bundle',
                      bundleCount: bundle.count,
                      outputs: orderOutputs(round.captureIds),
                    })}>{bundle.count} photo bundle · {money(bundle.price)}</Button
                >{/each}
            </div>
          </article>{:else}<p>No selections submitted yet.</p>{/each}
      </section>
      <section class="phd-card">
        <h3>Orders & payment records</h3>
        <label
          >Settlement, cancellation or refund reference<input
            maxlength="200"
            bind:value={paymentReference}
            placeholder="Invoice or payment reference"
          /></label
        >{#each draft.orders as order (order.id)}<article class="phd-order">
            <div class="phd-row">
              <strong>{recipient(order.recipientId)} · {money(order.total, order.currency)}</strong><span
                >{order.status}</span
              >
            </div>
            <p>
              {order.captureIds.length} photographs · {order.paymentTiming === 'before-editing'
                ? 'Payment before editing'
                : 'Payment after approval'}
            </p>
            <p>{order.terms}</p>
            <div class="phd-actions">
              {#if canSettle(order)}<Button
                  disabled={busy || !paymentReference.trim()}
                  onclick={() =>
                    mutate(`/orders/${order.id}/payment`, 'POST', { action: 'settle', reference: paymentReference })}
                  >Record payment received</Button
                ><Button
                  disabled={busy || !paymentReference.trim()}
                  onclick={() =>
                    mutate(`/orders/${order.id}/payment`, 'POST', { action: 'cancel', reference: paymentReference })}
                  >Cancel order</Button
                >{:else if order.status === 'settled'}<Button
                  disabled={busy || !paymentReference.trim()}
                  onclick={() =>
                    mutate(`/orders/${order.id}/payment`, 'POST', { action: 'refund', reference: paymentReference })}
                  >Record refund</Button
                >{:else if order.status === 'quoted'}<Button
                  disabled={busy || !paymentReference.trim()}
                  onclick={() =>
                    mutate(`/orders/${order.id}/payment`, 'POST', { action: 'cancel', reference: paymentReference })}
                  >Cancel quote</Button
                >{/if}
            </div>
          </article>{:else}<p>No confirmed orders yet.</p>{/each}{#each draft.receipts as receipt (receipt.id)}<small
            >{new Date(receipt.createdAt).toLocaleString()} · {receipt.action} · {receipt.reference}</small
          >{/each}
      </section>
      <section class="phd-card">
        <h3>Approve edited versions</h3>
        <label><input type="checkbox" bind:checked={clientApproval} />Request client approval before release</label
        >{#each eligible.filter( (capture) => draft?.orders.some( (order) => order.captureIds.includes(capture.id) ) ) as capture (capture.id)}<div
            class="phd-order"
          >
            <div class="phd-row">
              <strong>Photo {capture.number} · {capture.fileName}</strong><span>{capture.state}</span>
            </div>
            <div class="phd-actions">
              {#if shoot.albumId && capture.assetId}<a
                  href={Route.viewAlbumAsset({ albumId: shoot.albumId, assetId: capture.assetId })}>Edit photograph</a
                >{/if}<Button disabled={busy} onclick={() => revisions(capture)}>Load ready versions</Button
              >{#if versionChoices[capture.id]}<label
                  >Version<select bind:value={pinnedChoices[capture.id]}
                    ><option value="">Choose an edited version</option
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
                    })}>Pin approved version</Button
                >{/if}
            </div>
          </div>{:else}<p>Confirm an order to prepare its edited photographs.</p>{/each}
      </section>
    {:else if panel === 'publishing'}
      <section class="phd-card">
        <h3>Client collection</h3>
        <p>Publish prepares all required proofs and approved delivery files before switching the collection.</p>
        <div class="phd-row">
          <strong>{draft.publication?.status ?? 'Draft'}</strong><span
            >{draft.publication?.completed ?? 0} / {draft.publication?.total ?? 0} prepared</span
          >
        </div>
        {#if draft.publication?.error}<p role="alert">{draft.publication.error}</p>{/if}
        <div class="phd-actions">
          <Button
            variant="primary"
            disabled={busy}
            onclick={() => mutate('/publish', 'POST', { scope: 'all-eligible' })}>Publish all available proofs</Button
          ><Button
            disabled={busy || draft.rounds.length === 0}
            onclick={() => mutate('/publish', 'POST', { scope: 'selected' })}>Publish client selections</Button
          >{#if ['failed', 'queued', 'rendering'].includes(draft.publication?.status ?? '')}<Button
              disabled={busy}
              onclick={() => mutate('/retry')}>Retry interrupted publication</Button
            >{/if}
        </div>
      </section>
      <section class="phd-card">
        <h3>Invite a client</h3>
        <p>Generate a private invitation, then send it through your preferred contact method.</p>
        <div class="phd-fields">
          <label>Recipient name<input maxlength="100" bind:value={recipientName} /></label><label
            >Optional gallery password<input
              type="password"
              autocomplete="new-password"
              minlength="8"
              maxlength="72"
              bind:value={recipientPassword}
            /></label
          ><label>Invitation expiry<input type="date" bind:value={recipientExpiry} /></label>
        </div>
        <label
          ><input type="checkbox" bind:checked={recipientDownload} />Allow approved downloads after the order is settled</label
        ><label><input type="checkbox" bind:checked={restrictInvitation} />Restrict to selected captures</label
        >{#if selected.length}<p>
            {selected.length} captures included in this invitation.
          </p>{/if}{#if restrictInvitation}<div class="phd-recipient-captures">
            {#each eligible as capture (capture.id)}<label
                ><input
                  type="checkbox"
                  checked={selected.includes(capture.id)}
                  onchange={(event) =>
                    (selected = event.currentTarget.checked
                      ? [...selected, capture.id]
                      : selected.filter((id) => id !== capture.id))}
                />Photo {capture.number} · {capture.fileName}</label
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
            })}>Create invitation</Button
        >{#if invitation}<label>Invitation (shown once)<input readonly value={invitation} /></label><Button
            onclick={copyInvitation}>Copy invitation</Button
          >{/if}
      </section>
      <section class="phd-card">
        <h3>Recipient access</h3>
        {#each draft.recipients as row (row.id)}<div class="phd-order">
            <div class="phd-row"><strong>{row.name}</strong><span>{row.revoked ? 'Revoked' : 'Active'}</span></div>
            <p>
              {row.canProof ? 'Proofing enabled' : 'Proofing disabled'} · {row.canDownload
                ? 'Approved downloads enabled'
                : 'Downloads disabled'}{row.expiresAt
                ? ` · Expires ${new Date(row.expiresAt).toLocaleDateString()}`
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
                  })}>{row.revoked ? 'Restore access' : 'Revoke access'}</Button
              ><Button
                disabled={busy}
                onclick={() =>
                  mutate(`/recipients/${row.id}`, 'PATCH', {
                    revoked: row.revoked,
                    canProof: row.canProof,
                    canDownload: !row.canDownload,
                    captureIds: row.captureIds,
                    expiresAt: row.expiresAt,
                  })}>{row.canDownload ? 'Disable downloads' : 'Allow approved downloads'}</Button
              >
            </div>
          </div>{:else}<p>No recipients invited yet.</p>{/each}
      </section>
    {/if}
  {/if}
</div>
