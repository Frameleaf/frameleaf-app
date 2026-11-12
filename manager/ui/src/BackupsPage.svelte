<script lang="ts">
  // FL-1476 (proposed): Backups leads with when the last recovery point was made and one button to make another,
  // then where they're kept (and whether that's the photos' own drive), the recovery key, and the list.
  import Icon from './Icon.svelte';
  import { formatBytes } from './presentation';
  import { ageDays, when } from './OverviewPage.svelte';

  let { snapshots, status, backupRoot, storage, disabled, backUp, restore, exportKey, unlock, refresh } = $props<{
    snapshots: { id: string; time: string }[];
    status: { unlocked: boolean; keyAvailable: boolean };
    backupRoot: string;
    storage: { path: string; uses: string[]; device?: string | null; availableBytes: number | null }[];
    disabled: boolean;
    backUp: () => void;
    restore: (id: string) => void;
    exportKey: () => void;
    unlock: () => void;
    refresh: () => void;
  }>();

  let showAll = $state(false);
  const latest = $derived(snapshots[0]);
  const old = $derived(!latest || ageDays(latest.time) > 7);
  const place = $derived(storage.find((s) => s.uses.includes('backups')));
  const photos = $derived(storage.find((s) => s.uses.includes('media')));
  // A failing drive takes the photos and their recovery points with it.
  const sameDrive = $derived(!!place?.device && place.device === photos?.device);
  const shown = $derived(showAll ? snapshots : snapshots.slice(0, 5));
  const fullDate = (time: string) => new Date(time).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
</script>

<section class="card bk-status" data-tone={old ? 'warning' : 'good'} aria-labelledby="bk-status-title">
  <div class="bk-status-body">
    <span class="bk-mark"><Icon name={old ? 'warning' : 'shield'} /></span>
    <div>
      <span class="bk-eyebrow">Last recovery point</span>
      <h2 id="bk-status-title">{latest ? when(latest.time) : 'None yet'}</h2>
      <p class="meta">
        {#if !latest}Make one now. Manager also makes one before every update, restore and import.
        {:else if old}That’s {Math.floor(ageDays(latest.time))} days ago. Manager makes one when you ask, and before every update, restore and import.
        {:else}{snapshots.length} kept. Manager also makes one before every update, restore and import.{/if}
      </p>
    </div>
    <button class="button primary" {disabled} onclick={backUp}><Icon name="shield" />Make one now</button>
  </div>
</section>

<section class="card mt16" aria-labelledby="bk-where-title">
  <div class="card-header"><h2 id="bk-where-title">Where they’re kept</h2></div>
  <div class="list-row">
    <Icon name="folder" />
    <div><strong>{backupRoot}</strong><p>{place?.availableBytes != null ? `${formatBytes(place.availableBytes)} free on this drive.` : ''} Each recovery point is encrypted and holds only the database: albums, people, edits and settings.</p></div>
  </div>
  {#if sameDrive}
    <div class="list-row bk-warn">
      <Icon name="warning" />
      <div><strong>On the same drive as your photos</strong><p>If that drive fails, the photos and their recovery points go together. Copy this folder to another drive or another computer now and then.</p></div>
    </div>
  {/if}
  <div class="list-row">
    <Icon name="key" />
    <div><strong>Recovery key</strong><p>Recovery points can’t be opened without it, even by Manager after a reinstall. Keep it off this server, in a password manager or on paper.</p></div>
    <button class="button quiet" disabled={!status.keyAvailable} onclick={exportKey}>Export key</button>
  </div>
</section>

<section class="card mt16" aria-labelledby="bk-list-title">
  <div class="card-header"><h2 id="bk-list-title">Recovery points</h2><button class="button quiet" {disabled} onclick={refresh}>Refresh</button></div>
  {#each shown as item, i (item.id)}
    <div class="list-row">
      <Icon name={i === 0 ? 'check-circle' : 'clock'} />
      <div><strong>{when(item.time)}</strong><p>{fullDate(item.time)}</p></div>
      <button class="button quiet" {disabled} onclick={() => restore(item.id)}>Restore…</button>
    </div>
  {:else}
    <div class="card-body">
      <p class="muted">No recovery points yet.</p>
      {#if !status.unlocked}<button class="button quiet mt16" {disabled} onclick={unlock}>Open recovery points from another server…</button>{/if}
    </div>
  {/each}
  {#if snapshots.length > 5}
    <div class="card-footer"><button class="text-button" onclick={() => (showAll = !showAll)}>{showAll ? 'Show fewer' : `Show all ${snapshots.length}`}</button></div>
  {/if}
</section>

<div class="notice mt16">
  <Icon name="info" />
  <div><strong>What a restore does</strong><p>It puts albums, people, edits and settings back as they were at that time. It doesn’t bring back photos or videos that were deleted from the drive; those need a copy of the photos folder.</p></div>
</div>

<style>
  .bk-status-body { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 20px; }
  .bk-mark { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 13px; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--panel)); }
  .bk-mark :global(svg) { width: 22px; height: 22px; }
  .bk-status[data-tone='warning'] { border-color: color-mix(in srgb, var(--amber) 30%, var(--border)); }
  .bk-status[data-tone='warning'] .bk-mark { color: var(--amber); background: color-mix(in srgb, var(--amber) 12%, var(--panel)); }
  .bk-eyebrow { font-size: 12px; color: var(--muted); }
  .bk-status h2 { font-size: 22px; letter-spacing: -0.4px; margin: 2px 0 4px; }
  .bk-status .meta { font-size: 14px; }
  .button { display: inline-flex; align-items: center; gap: 8px; }
  .button :global(svg) { width: 15px; height: 15px; }
  .list-row > div > strong { overflow-wrap: anywhere; }
  .bk-warn > :global(svg) { color: var(--amber) !important; }
  .card-footer { padding: 14px 20px; border-top: 1px solid var(--border); }
  @media (max-width: 640px) {
    .bk-status-body { grid-template-columns: auto minmax(0, 1fr); }
    .bk-status-body > .button { grid-column: 1 / -1; justify-content: center; }
  }
</style>
