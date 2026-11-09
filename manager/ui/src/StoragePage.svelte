<script lang="ts" module>
  // FL-1323: the words and steps of each move, from the approved prototype (frameleaf-prototype src/manager-setup.mjs MOVES).
  export type MoveKind = 'media' | 'database' | 'thumbs' | 'rebuild';
  export const MOVES: Record<
    MoveKind,
    { title: string; pick?: string; folder?: string; notes: string[]; accept?: string; confirm: string }
  > = {
    media: {
      title: 'Move photos and videos',
      pick: 'Choose a bigger drive',
      folder: 'frameleaf-photos',
      notes: [
        'Frameleaf is unavailable while the move runs. Uploads and background work stop first, and a verified database recovery point is saved.',
        'Manager copies and checks every file, then switches the folder. The original copy is kept.',
      ],
      accept:
        'I have a separate backup of my photos and videos, and understand that returning to the old folder after new writes requires another verified move.',
      confirm: 'Move the library',
    },
    database: {
      title: 'Move the database',
      pick: 'Choose a folder for the database',
      folder: 'frameleaf-databases',
      notes: [
        'Frameleaf is unavailable until the move finishes.',
        'Manager saves a recovery point, copies the database and checks it. The current folder is kept, and if anything fails Frameleaf goes back to it.',
      ],
      confirm: 'Move the database',
    },
    thumbs: {
      title: 'Move thumbnails',
      pick: 'Choose a folder for thumbnails',
      folder: 'frameleaf-thumbnails',
      notes: [
        'Frameleaf is unavailable until the copy finishes. Uploads and background work pause first.',
        'Manager checks every copy before switching. If that drive ever fails, Frameleaf can make new thumbnails from your photos.',
      ],
      confirm: 'Move thumbnails',
    },
    rebuild: {
      title: 'Put thumbnails back with your photos',
      notes: [
        'Frameleaf starts straight away and makes new thumbnails in the background. On a large library this can take many hours.',
        'Your photos and videos are not touched.',
      ],
      confirm: 'Put back and rebuild',
    },
  };
  /** Which review and start each move uses on the Manager API. */
  const ROUTES: Record<MoveKind, { review: string; start: string }> = {
    media: { review: 'review-move', start: 'move-library' },
    database: { review: 'review-database-move', start: 'move-database' },
    thumbs: { review: 'review-thumbnail-move', start: 'move-thumbnails' },
    rebuild: { review: 'review-thumbnails-home', start: 'thumbnails-home' },
  };
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import FolderPicker from './FolderPicker.svelte';
  import DriveLine from './DriveLine.svelte';
  import DriveSuggestion from './DriveSuggestion.svelte';
  import Icon from './Icon.svelte';
  import { startKey } from './request-key';
  import { formatBytes, readable } from './presentation';
  import { driveHint, fastFolderIssue, gigabytes, type Drive, type Suggestion } from './drives';

  type Usage = {
    media: { path: string; bytes: number | null };
    database: { path: string; bytes: number | null };
    thumbnails: { path: string | null; own: boolean; missing: boolean | null; bytes: number | null; files: number | null };
    drives: Drive[] | null;
    suggestions: { database: Suggestion | null; thumbs: Suggestion | null } | null;
  };
  let {
    api,
    folders = null,
    roots = [],
    storage = [],
    disabled = false,
    started,
  } = $props<{
    api: (path: string, body?: unknown) => Promise<any>;
    /** Where Manager's own folders are, when folders are chosen by browsing (dashboard.folderSetup). */
    folders?: { media: string; database: string; backups: string; manager: string } | null;
    /** Without browsing: the folders mounted into Manager to choose from. */
    roots?: string[];
    /** GET /manager-api/storage (FL-1324 StorageSpace): a place's drive is nearly full when its folder says so. */
    storage?: { path: string; uses?: string[]; lowOnSpace?: boolean | null; measurable?: boolean }[];
    disabled?: boolean;
    started: (id: string) => void;
  }>();

  let usage = $state<Usage | null>(null),
    loadError = $state(''),
    checking = $state(false),
    picking = $state<MoveKind | null>(null),
    moving = $state<{ kind: MoveKind; path?: string } | null>(null),
    review = $state<any>(null),
    reviewError = $state(''),
    accepted = $state(false),
    starting = $state(false),
    dialog = $state<HTMLDialogElement>(),
    rootDialog = $state<HTMLDialogElement>();

  async function load() {
    checking = true;
    try {
      usage = await api('storage-usage');
      loadError = '';
    } catch (e) {
      loadError = readable(e instanceof Error ? e.message : 'request_failed');
    } finally {
      checking = false;
    }
  }
  onMount(load);

  const drives = $derived(usage?.drives ?? []);
  /** "86 GB", "1.8 TB" as the prototype shows them; a library under 1 GB in plain units rather than "0 GB". */
  const amount = (bytes: number) => (bytes < 1024 ** 3 ? formatBytes(bytes) : gigabytes(bytes));
  const used = (bytes: number | null | undefined, rest = '') => (bytes == null ? '' : `${amount(bytes)} used${rest}`);
  const low = (path: string | null | undefined) => !!path && storage.some((place: { path: string; lowOnSpace?: boolean | null }) => place.path === path && place.lowOnSpace);
  /** FL-1324: a folder only Docker reaches (an imported library's thumbnails or database) can't be measured from here. */
  const unmeasurable = (path: string | null | undefined) =>
    !!path && storage.some((place: { path: string; measurable?: boolean }) => place.path === path && place.measurable === false);
  const view = $derived(
    !usage ? 'media' : usage.thumbnails.missing ? 'missing' : usage.thumbnails.own ? 'fast' : 'media',
  );

  /** The folder the review shows and creates: inside the chosen one when folders are browsed. */
  const destination = (kind: MoveKind, path: string) => (folders ? `${path}/${MOVES[kind].folder}` : path);
  const pickerStart = (kind: MoveKind) => {
    const suggestion = kind === 'database' ? usage?.suggestions?.database : kind === 'thumbs' ? usage?.suggestions?.thumbs : null;
    if (suggestion?.status === 'found' || suggestion?.status === 'too_full') return suggestion.drive.base;
    const current = kind === 'media' ? usage?.media.path : kind === 'database' ? usage?.database.path : usage?.thumbnails.path;
    return current ? current.slice(0, current.lastIndexOf('/')) || '/' : '/mnt';
  };

  async function choose(kind: MoveKind) {
    picking = kind;
    if (!folders) {
      await tick();
      rootDialog?.showModal();
    }
  }
  /** Which open() the dialog belongs to: a review answered after its dialog closed is never shown in another. */
  let opened = 0;
  async function open(kind: MoveKind, path?: string) {
    const request = ++opened;
    picking = null;
    rootDialog?.close();
    moving = { kind, path };
    review = null;
    reviewError = '';
    accepted = false;
    await tick();
    dialog?.showModal();
    try {
      const route = ROUTES[kind].review;
      const answer = await api(
        route,
        kind === 'rebuild' ? {} : kind === 'database' ? { databaseRoot: path } : { root: path },
      );
      if (request === opened) review = answer;
    } catch (e) {
      if (request === opened)
        reviewError = readable(e instanceof Error ? e.message : 'request_failed', (e as { detail?: string }).detail);
    }
  }
  /** A start retried after a lost response sends the same key, so Manager returns the operation it started. */
  const keys = new Map<string, string>();
  function close() {
    if (starting) return;
    if (review) keys.delete(review.id);
    opened++;
    dialog?.close();
    moving = null;
    review = null;
  }
  async function confirm() {
    if (!moving || !review || starting) return;
    starting = true;
    reviewError = '';
    try {
      const { id } = await api(ROUTES[moving.kind].start, { id: review.id, key: startKey(keys, review.id) });
      keys.delete(review.id);
      dialog?.close();
      moving = null;
      review = null;
      started(id);
    } catch (e) {
      reviewError = readable(e instanceof Error ? e.message : 'request_failed', (e as { detail?: string }).detail);
    } finally {
      starting = false;
    }
  }
  /** What the review measured, in the prototype's words. */
  const size = (kind: MoveKind, value: any) => {
    if (kind === 'thumbs') return `${value.files.toLocaleString()} files · ${amount(value.bytes)} to copy`;
    if (kind === 'database') return `${amount(value.databaseBytes)} to copy`;
    if (kind === 'rebuild') return value.assets == null ? '' : `${value.assets.toLocaleString()} thumbnails to make again`;
    return `${amount(value.bytes)} to copy`;
  };
  const waitsForPause = (kind: MoveKind) => (kind === 'media' || kind === 'thumbs') && review && review.available === false;
</script>

{#snippet hint(path: string | null | undefined)}
  <DriveLine {path} {drives} low={low(path)} unmeasurable={unmeasurable(path)} />
{/snippet}

{#snippet suggestion(kind: MoveKind, value: Suggestion | null | undefined)}
  {#if value?.status === 'found'}
    <DriveSuggestion suggestion={value} action={`Move to ${value.drive.name}…`} {disabled} use={() => open(kind, value.folder)} />
  {:else}
    <DriveSuggestion suggestion={value} action="" use={() => {}} />
  {/if}
{/snippet}

{#snippet place(icon: string, title: string, path: string | null | undefined, usedText: string, note: string, problem: boolean, advice: any, actions: any)}
  <li class="sp-place" data-status={problem ? 'problem' : undefined}>
    <span class="sp-mark" class:neutral={!problem}><Icon name={problem ? 'alert-circle' : icon} /></span>
    <div class="sp-body">
      <h2>{title}</h2>
      {#if path}<p>{path}</p>{/if}
      {@render hint(path)}
      {#if usedText}<p>{usedText}</p>{/if}
      {#if note}<p>{note}</p>{/if}
      {@render advice?.()}
      <div class="sp-actions">{@render actions()}</div>
    </div>
  </li>
{/snippet}

<div class="page-heading sp-heading"><div class="spread"><h1 tabindex="-1">Storage</h1></div><p>Where your library keeps its data. Move any of it to another drive when you need to.</p></div>
{#if loadError && !usage}
  <div class="notice warning" role="alert"><Icon name="warning" /><div class="grow"><strong>{loadError}</strong></div><button class="button quiet" onclick={load}>Try again</button></div>
{:else if usage}
  <ul class="sp-places" aria-label="Where your library keeps its data">
    {#snippet mediaActions()}<button type="button" class="button quiet" {disabled} onclick={() => choose('media')}>Move…</button>{/snippet}
    {@render place('images', 'Photos and videos', usage.media.path, used(usage.media.bytes), '', false, null, mediaActions)}

    {#snippet databaseAdvice()}{@render suggestion('database', usage!.suggestions?.database)}{/snippet}
    {#snippet databaseActions()}<button type="button" class="button quiet" {disabled} onclick={() => choose('database')}>{usage!.suggestions?.database?.status === 'found' ? 'Choose another folder…' : 'Move…'}</button>{/snippet}
    {@render place('database-outline', 'Database', usage.database.path, used(usage.database.bytes), '', false, databaseAdvice, databaseActions)}

    {#if view === 'missing'}
      {#snippet missingActions()}
        <button type="button" class="button quiet" disabled={checking} onclick={load}>{checking ? 'Checking…' : 'Check again'}</button>
        <button type="button" class="button quiet" {disabled} onclick={() => open('rebuild')}>Put back with your photos…</button>
      {/snippet}
      {@render place('image-outline', 'The thumbnail drive isn’t connected', usage.thumbnails.path, '', 'Frameleaf can’t start without it. Your photos are safe. Connect the drive and check again, or put thumbnails back with your photos and make them again.', true, null, missingActions)}
    {:else if view === 'fast'}
      {#snippet fastActions()}<button type="button" class="button quiet" {disabled} onclick={() => choose('thumbs')}>Move…</button>{/snippet}
      {@render place('image-outline', 'Thumbnails', usage.thumbnails.path, used(usage.thumbnails.bytes), 'If this drive fails, Frameleaf can make new thumbnails from your photos.', false, null, fastActions)}
    {:else}
      {#snippet thumbsAdvice()}{@render suggestion('thumbs', usage!.suggestions?.thumbs)}{/snippet}
      {#snippet thumbsActions()}<button type="button" class="button quiet" {disabled} onclick={() => choose('thumbs')}>{usage!.suggestions?.thumbs?.status === 'found' ? 'Choose another folder…' : 'Move…'}</button>{/snippet}
      {@render place('image-outline', 'Thumbnails', usage.media.path, used(usage.thumbnails.bytes, ', with your photos and videos'), '', false, thumbsAdvice, thumbsActions)}
    {/if}
  </ul>
{/if}

{#if picking && folders}
  <FolderPicker
    title={MOVES[picking].pick ?? ''}
    start={pickerStart(picking)}
    {api}
    issue={picking === 'media' ? undefined : (path: string) => fastFolderIssue(path, folders!, picking === 'database' ? 'database' : 'thumbnails')}
    use={(path: string) => open(picking!, destination(picking!, path))}
    close={() => (picking = null)}
  />
{:else if picking}
  <dialog class="folder-picker" bind:this={rootDialog} aria-label={MOVES[picking].pick} oncancel={(event) => { event.preventDefault(); rootDialog?.close(); picking = null; }}>
    <h2>{MOVES[picking].pick}</h2>
    <ul class="folder-list">
      {#each roots as root (root)}<li><button type="button" onclick={() => open(picking!, root)}><Icon name="folder" /><span>{root}</span></button></li>{/each}
      {#if !roots.length}<li class="folder-empty">No other drive is mounted into Manager. Add one to Manager’s folders first.</li>{/if}
    </ul>
    <div class="actions folder-actions"><button type="button" class="button quiet" onclick={() => { rootDialog?.close(); picking = null; }}>Cancel</button></div>
  </dialog>
{/if}

{#if moving}
  {@const move = MOVES[moving.kind]}
  <dialog class="sp-move" bind:this={dialog} aria-label={move.title} oncancel={(event) => { event.preventDefault(); close(); }}>
    <header><h2>{move.title}</h2></header>
    {#if moving.path}
      {@const drive = driveHint(moving.path, drives)}
      <dl class="sp-facts"><div><dt>New folder</dt><dd>{moving.path}</dd></div>{#if drive}<div><dt>Drive</dt><dd>{drive.text}</dd></div>{/if}</dl>
    {/if}
    {#if review}
      {@const measured = size(moving.kind, review)}
      {#if measured}<strong class="sp-move-size">{measured}</strong>{/if}
    {:else if !reviewError}
      <strong class="sp-move-size checking">Checking the folder…</strong>
    {/if}
    <div class="sp-move-notes">{#each move.notes as note (note)}<p>{note}</p>{/each}</div>
    {#if waitsForPause(moving.kind)}
      <p class="sp-move-problem" role="status"><Icon name="info-outline" /><span>This server can’t yet confirm that uploads and background work have stopped, so moving isn’t available. Nothing was stopped or moved.</span></p>
    {/if}
    {#if reviewError}<p class="sp-move-problem" role="alert"><Icon name="info-outline" /><span>{reviewError}</span></p>{/if}
    {#if move.accept}
      <label class="sp-check"><input type="checkbox" bind:checked={accepted} />{move.accept}</label>
    {/if}
    <footer>
      <button type="button" class="button quiet" disabled={starting} onclick={close}>Cancel</button>
      <button type="button" class="button primary" disabled={disabled || starting || !review || (!!move.accept && !accepted) || waitsForPause(moving.kind)} onclick={confirm}>{move.confirm}</button>
    </footer>
  </dialog>
{/if}

<style>
  /* FL-1323: Manager's Storage page, measured from the prototype (frameleaf-prototype manager-setup.css .mgs-issue,
     .mgs-drive, .mgs-suggest, .mgs-move; accounts-libraries.css .resource-dialog; first-run-setup.css .frs-facts). */
  /* The prototype's heading (first-run-setup.css .frs-head), as FL-1317 gives the setup screens. */
  .sp-heading {
    margin-bottom: 34px;
  }
  .sp-heading h1 {
    font-size: 28px;
    font-weight: 600;
    line-height: 1.15;
    letter-spacing: -0.8px;
    text-wrap: balance;
  }
  .sp-heading p {
    margin-top: 20px;
    font-size: 14px;
    line-height: 1.5;
  }
  .sp-places {
    font-size: 14px;
    line-height: 1.5;
    display: grid;
    gap: 12px;
    max-width: 820px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .sp-place {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 16px;
    padding: 20px;
    border-radius: 12px;
    background: var(--panel);
  }
  .sp-mark {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    color: #f0625d;
    background: color-mix(in srgb, #f0625d 14%, transparent);
  }
  .sp-mark.neutral {
    color: var(--muted);
    background: var(--raised);
  }
  .sp-mark :global(svg) {
    width: 20px;
    height: 20px;
  }
  .sp-body {
    display: grid;
    gap: 8px;
    justify-items: start;
    min-width: 0;
  }
  .sp-body h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.5;
    letter-spacing: -0.2px;
    text-wrap: balance;
  }
  .sp-body > p {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  /* The drive line and suggestion are FL-1321's shared .st-drive and .st-suggest (style.css); here they fill the row. */
  .sp-body > :global(.st-suggest),
  .sp-body > :global(.st-suggest-note) {
    width: 100%;
  }
  .sp-move-problem {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    width: 100%;
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }
  .sp-move-problem :global(svg) {
    width: 16px;
    height: 16px;
    margin-top: 2px;
  }
  .sp-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .sp-actions .button {
    margin-top: 8px;
  }
  .sp-place .button,
  .sp-move .button {
    width: auto;
    min-height: 34px;
    padding: 7px 11px;
    border-radius: 8px;
    background: var(--raised);
    font-weight: 400;
    line-height: 1.5;
  }
  .sp-place .button {
    font-size: 14px;
  }
  .sp-body :global(.st-suggest .button) {
    line-height: 1.5;
  }
  .sp-move {
    font-size: 14px;
    line-height: 1.5;
    width: min(620px, calc(100vw - 32px));
    max-width: none;
    padding: 24px;
    border-radius: 12px;
    box-shadow: 0 24px 80px #00000080;
  }
  .sp-move header {
    margin-bottom: 24px;
  }
  .sp-move h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    line-height: 1.5;
    letter-spacing: -0.4px;
    text-wrap: balance;
  }
  .sp-facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px 16px;
    margin: 0;
    padding: 19px 0;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 13px;
  }
  .sp-facts dt {
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
  }
  .sp-facts dd {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .sp-move-size {
    display: block;
    margin: 12px 0;
    font-size: 14px;
    line-height: 1.5;
  }
  .sp-move-size.checking {
    color: var(--muted);
    font-weight: 400;
  }
  .sp-move-notes {
    display: grid;
    gap: 8px;
  }
  .sp-move-notes p {
    margin: 0;
    font-size: 12px;
    line-height: 1.7;
  }
  .sp-move-problem {
    margin-top: 16px;
  }
  .sp-check {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin-top: 16px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }
  .sp-check input {
    width: auto;
    flex-shrink: 0;
    margin-top: 3px;
    accent-color: var(--accent);
  }
  .sp-move footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 28px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }
  .sp-move footer .button {
    font-size: 14px;
  }
  .sp-move footer .button.primary {
    background: var(--accent);
    font-weight: 600;
  }
  /* Phones: 44px touch targets, as across the prototype. */
  @media (max-width: 700px) {
    .sp-place .button,
    .sp-move .button,
    .sp-body :global(.st-suggest .button) {
      min-height: 44px;
    }
  }
  @media (max-width: 640px) {
    .sp-place {
      gap: 12px;
      padding: 16px;
    }
  }
  @media (max-width: 540px) {
    .sp-move {
      padding: 18px;
    }
  }
</style>
