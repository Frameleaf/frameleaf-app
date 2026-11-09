<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { readable } from './presentation';
  let {
    title,
    start,
    api,
    issue = () => null,
    use,
    close,
  } = $props<{
    title: string;
    start: string;
    api: (path: string, body?: unknown) => Promise<any>;
    issue?: (path: string) => string | null;
    use: (path: string) => void;
    close: () => void;
  }>();
  let dialog = $state<HTMLDialogElement>(),
    listing = $state<{ path: string; parent: string | null; folders: { name: string; path: string }[]; truncated: boolean } | null>(null),
    error = $state('');
  let latest = 0;
  async function open(path: string) {
    const request = ++latest;
    error = '';
    try {
      const answer = await api('folders', { path });
      if (request === latest) listing = answer;
    } catch (e) {
      if (request === latest) error = readable(e instanceof Error ? e.message : 'storage_volume_missing');
    }
  }
  onMount(() => {
    dialog?.showModal();
    void open(start);
  });
  const problem = $derived(listing ? issue(listing.path) : null);
</script>

<dialog bind:this={dialog} class="folder-picker" aria-label={title} oncancel={(event) => { event.preventDefault(); close(); }}>
  <h2>{title}</h2>
  <div class="folder-path">
    <button type="button" class="button quiet" aria-label="Up one folder" disabled={!listing?.parent} onclick={() => open(listing!.parent!)}><Icon name="arrow"/></button>
    <span>{listing?.path ?? ''}</span>
  </div>
  <ul class="folder-list">
    {#each listing?.folders ?? [] as folder (folder.path)}
      <li><button type="button" onclick={() => open(folder.path)}><Icon name="folder"/><span>{folder.name}</span></button></li>
    {/each}
    {#if listing && !listing.folders.length}<li class="folder-empty">No folders inside this one.</li>{/if}
    {#if listing?.truncated}<li class="folder-empty">Only the first 500 folders are shown.</li>{/if}
  </ul>
  {#if error}<p class="field-error" role="alert">{error}</p>{:else if problem}<p class="meta" role="status">{problem}</p>{/if}
  <div class="actions folder-actions">
    <button type="button" class="button quiet" onclick={close}>Cancel</button>
    <button type="button" class="button primary" disabled={!listing || !!problem} onclick={() => use(listing!.path)}>Use this folder</button>
  </div>
</dialog>
