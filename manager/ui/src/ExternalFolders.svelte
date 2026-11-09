<script lang="ts">
  import FolderPicker from './FolderPicker.svelte';
  import Icon from './Icon.svelte';
  import { externalFolderIssue, externalFolders, setExternalFolders } from './presentation';
  let {
    mounts = $bindable(),
    occupied,
    api,
    saving = null,
  } = $props<{
    /** The Frameleaf server's "Extra folders" text: this is a friendlier view of the same setting. */
    mounts: string;
    occupied: string[];
    api: (path: string, body?: unknown) => Promise<any>;
    saving?: { dirty: boolean; disabled: boolean; save: () => void; discard: () => void } | null;
  }>();
  let browsing = $state(false);
  const folders = $derived(externalFolders(mounts));
  const write = (next: { path: string; readOnly: boolean }[]) => (mounts = setExternalFolders(mounts, next));
</script>

<section class="card mt16">
  <div class="card-header">
    <div><h2>External folders</h2><p class="meta">Already keep photos somewhere else on this server? Add the folder and Frameleaf can show them without moving or copying them.</p></div>
    <button type="button" class="button" onclick={() => (browsing = true)}>Add a folder…</button>
  </div>
  {#if folders.length}
    <ul class="external-list">
      {#each folders as folder (folder.path)}
        <li>
          <Icon name="folder"/><span class="external-path">{folder.path}</span>
          <label class="external-mode"><input type="checkbox" checked={folder.readOnly} onchange={() => write(folders.map((item) => (item === folder ? { ...item, readOnly: !item.readOnly } : item)))}/>Read-only</label>
          <button type="button" class="button quiet" aria-label={`Remove ${folder.path}`} onclick={() => write(folders.filter((item) => item !== folder))}>Remove</button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if saving?.dirty}
    <div class="disclosure"><p>Saving restarts Frameleaf. Photo access pauses for about a minute.</p><div class="actions mt16"><button type="button" class="button primary" disabled={saving.disabled} onclick={saving.save}>Save and restart Frameleaf</button><button type="button" class="button quiet" disabled={saving.disabled} onclick={saving.discard}>Discard changes</button></div></div>
  {/if}
</section>
{#if browsing}
  <FolderPicker
    title="Add an external folder"
    start="/mnt"
    {api}
    issue={(path) => externalFolderIssue(path, occupied, folders)}
    use={(path) => { write([...folders, { path, readOnly: true }]); browsing = false; }}
    close={() => (browsing = false)}
  />
{/if}
