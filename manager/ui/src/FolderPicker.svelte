<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { readable } from './presentation';
  let {
    title,
    start,
    api,
    issue = () => null,
    note = () => null,
    create = false,
    use,
    close,
  } = $props<{
    title: string;
    start: string;
    api: (path: string, body?: unknown) => Promise<any>;
    issue?: (path: string) => string | null;
    /** Something worth knowing about a folder that doesn't stop it being used. */
    note?: (path: string) => string | null;
    /** Offers "New folder" inside the open one. */
    create?: boolean;
    use: (path: string) => void;
    close: () => void;
  }>();
  let dialog = $state<HTMLDialogElement>(),
    listing = $state<{ path: string; parent: string | null; folders: { name: string; path: string }[]; truncated: boolean } | null>(null),
    error = $state(''),
    loading = $state(true);
  let latest = 0;
  async function open(path: string) {
    const request = ++latest;
    error = '';
    loading = true;
    try {
      const answer = await api('folders', { path });
      if (request === latest) listing = answer;
    } catch (e) {
      if (request === latest) error = readable(e instanceof Error ? e.message : 'storage_volume_missing');
    } finally {
      if (request === latest) loading = false;
    }
  }
  onMount(() => {
    dialog?.showModal();
    void open(start);
  });
  const problem = $derived(listing ? issue(listing.path) : null);
  const remark = $derived(listing && !problem ? note(listing.path) : null);
  let naming = $state(false),
    name = $state(''),
    creating = $state(false);
  async function make() {
    if (!listing || !name.trim() || creating) return;
    // The same sequence as open(): an answer for a folder since left is dropped, never shown over the one open now.
    const request = ++latest;
    creating = true;
    error = '';
    try {
      const made = await api('create-folder', { path: listing.path, name: name.trim() });
      if (request !== latest) return;
      listing = made;
      naming = false;
      name = '';
    } catch (e) {
      if (request === latest) error = readable(e instanceof Error ? e.message : 'storage_permissions');
    } finally {
      creating = false;
    }
  }
</script>

<dialog bind:this={dialog} class="folder-picker" aria-label={title} oncancel={(event) => { event.preventDefault(); close(); }}>
  <h2>{title}</h2>
  <div class="folder-path">
    <button type="button" class="button quiet" aria-label="Up one folder" disabled={!listing?.parent} onclick={() => open(listing!.parent!)}><Icon name="arrow"/></button>
    <span>{listing?.path ?? ''}</span>
    {#if create}<button type="button" class="button quiet" disabled={!listing || listing.path === '/' || naming} onclick={() => (naming = true)}>New folder</button>{/if}
  </div>
  {#if naming}
    <form class="folder-new" onsubmit={(event) => { event.preventDefault(); void make(); }}>
      <!-- svelte-ignore a11y_autofocus -->
      <input bind:value={name} aria-label="Name of the new folder" placeholder="Folder name" autocomplete="off" spellcheck="false" maxlength="255" autofocus />
      <button type="submit" class="button" disabled={!name.trim() || /[\/\n,:]/.test(name) || creating}>Create</button>
      <button type="button" class="button quiet" onclick={() => { naming = false; name = ''; }}>Cancel</button>
    </form>
  {/if}
  <ul class="folder-list">
    {#each listing?.folders ?? [] as folder (folder.path)}
      <li><button type="button" onclick={() => open(folder.path)}><Icon name="folder"/><span>{folder.name}</span></button></li>
    {/each}
    {#if listing?.path === '/'}<li class="folder-empty">Choose a drive, then a folder on it.</li>{/if}
    {#if listing && !listing.folders.length}<li class="folder-empty">No folders inside this one.</li>{/if}
    {#if listing?.truncated}<li class="folder-empty">Only the first 500 folders are shown.</li>{/if}
  </ul>
  {#if error}<p class="field-error" role="alert">{error}</p>{:else if problem}<p class="meta" role="status">{problem}</p>{:else if remark}<p class="meta" role="status">{remark}</p>{/if}
  <div class="actions folder-actions">
    <button type="button" class="button quiet" onclick={close}>Cancel</button>
    <button type="button" class="button primary" disabled={!listing || loading || !!error || !!problem || listing.path === '/'} onclick={() => use(listing!.path)}>Use this folder</button>
  </div>
</dialog>
