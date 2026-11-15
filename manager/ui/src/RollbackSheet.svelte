<script lang="ts">
  // FL-973 (frameleaf-prototype ManagerRollback, FL-773): what goes back, what stays and what was done since the
  // update and will be undone, then a typed confirmation. Going back itself runs as a Manager operation.
  import Icon from './Icon.svelte';

  type Since = { uploads: number; libraryFiles: number; albums: number; names: number } | null;
  let { review, busy, confirm, cancel } = $props<{
    review: { from: string; to: string; updatedAt: number; since: Since };
    busy: boolean;
    confirm: () => void;
    cancel: () => void;
  }>();

  const CONFIRM = 'go back';
  const version = (tag: string) => tag.replace(/^frameleaf-v?/, '');
  const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
  let dialog = $state<HTMLDialogElement>();
  let typed = $state('');
  const ready = $derived(typed.trim().toLowerCase() === CONFIRM);
  const at = $derived(new Date(review.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  const lost = $derived.by(() => {
    const since = review.since;
    if (!since) return ['Anything added or changed in Frameleaf since the update'];
    const lines: string[] = [];
    if (since.uploads)
      lines.push(`${plural(since.uploads, 'photo or video', 'photos and videos')} uploaded since the update: they stay on the drive, and Library care › Photos found on the drive adds them again`);
    if (since.libraryFiles) lines.push(`${plural(since.libraryFiles, 'file', 'files')} from your folders: they’re added again at the next folder scan`);
    if (since.albums || since.names) {
      const made = [since.albums && plural(since.albums, 'album made', 'albums made'), since.names && plural(since.names, 'name given to a face', 'names given to faces')];
      lines.push(`${made.filter(Boolean).join(' and ')} since the update`);
    }
    return lines.length ? lines : ['Nothing was added since the update'];
  });
  $effect(() => {
    dialog?.showModal();
  });
</script>

<dialog bind:this={dialog} class="rollback-sheet" aria-labelledby="rollback-title" oncancel={(event) => { event.preventDefault(); if (!busy) cancel(); }}>
  <div class="modal-body">
    <h2 id="rollback-title">Go back to Frameleaf {version(review.to)}?</h2>
    <section>
      <h3>What goes back</h3>
      <ul>
        <li><Icon name="restore" />Frameleaf {version(review.to)}, as it was before the update</li>
        <li><Icon name="restore" />Your settings as they were at {at}</li>
        <li><Icon name="restore" />The database as it was at {at}</li>
      </ul>
    </section>
    <section>
      <h3>What stays</h3>
      <ul>
        <li><Icon name="check" />Every photo and video file, including new ones</li>
        <li><Icon name="check" />Your drives and folders</li>
      </ul>
    </section>
    <section class="is-lost">
      <h3>Done since the update, which will be undone</h3>
      <ul>
        {#each lost as line (line)}<li><Icon name="warning" />{line}</li>{/each}
      </ul>
    </section>
    <p class="rollback-time">Frameleaf is closed for about 5 minutes while this happens.</p>
    <label class="field">
      <span>Type <strong>{CONFIRM}</strong> to confirm</span>
      <input bind:value={typed} autocomplete="off" spellcheck="false" />
    </label>
  </div>
  <div class="modal-footer">
    <button class="button quiet" disabled={busy} onclick={cancel}>Cancel</button>
    <button class="button primary" disabled={busy || !ready} onclick={confirm}>Go back to {version(review.to)}</button>
  </div>
</dialog>

<style>
  .rollback-sheet { width: 600px; }
  section { margin-top: 22px; }
  h3 { font-size: 14px; font-weight: 500; margin-bottom: 10px; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  li { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 10px; font-size: 14px; line-height: 1.5; color: var(--muted); }
  li :global(svg) { width: 16px; height: 16px; margin-top: 2px; color: var(--accent); }
  .is-lost li :global(svg) { color: var(--amber); }
  .rollback-time { margin-top: 22px; font-size: 14px; color: var(--muted); }
  .field { margin-top: 18px; }
  .field strong { color: var(--text); font-weight: 500; }
  @media (max-width: 480px) {
    .modal-footer { flex-wrap: wrap; }
    .modal-footer .button { flex: 1; justify-content: center; }
  }
</style>
