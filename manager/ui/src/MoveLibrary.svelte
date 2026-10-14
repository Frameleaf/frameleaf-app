<script lang="ts">
  import { formatBytes, readable } from './presentation';
  let {
    roots,
    disabled = false,
    api,
    started,
  } = $props<{
    roots: string[];
    disabled?: boolean;
    api: (path: string, body?: unknown) => Promise<any>;
    started: (id: string) => void;
  }>();
  let root = $state(''),
    review = $state<any>(null),
    accepted = $state(false),
    busy = $state(false),
    error = $state('');
  async function check() {
    busy = true;
    error = '';
    review = null;
    accepted = false;
    try {
      review = await api('review-move', { root });
    } catch (e) {
      error = readable(e instanceof Error ? e.message : 'media_move_failed');
    } finally {
      busy = false;
    }
  }
  async function move() {
    if (!review || !accepted || disabled || busy) return;
    busy = true;
    error = '';
    try {
      started((await api('move-library', { id: review.id, key: crypto.randomUUID() })).id);
    } catch (e) {
      error = readable(e instanceof Error ? e.message : 'media_move_failed');
    } finally {
      busy = false;
    }
  }
</script>

<section class="card mt16">
  <div class="card-header"><h2>Move photos to a bigger drive</h2></div>
  <div class="card-body">
    <p>
      Manager copies and checks every file, then switches the media folder. The original copy is kept. PostgreSQL and
      database backups stay where they are.
    </p>
    <p class="meta mt16">
      For a new server, restore a complete media backup there. Manager’s database backups do not contain photos or
      videos.
    </p>
    <label class="field mt16"
      ><span id="manager-move-drive-label">New drive</span>
      <select
        aria-labelledby="manager-move-drive-label"
        bind:value={root}
        disabled={disabled || busy}
        onchange={() => {
          review = null;
          accepted = false;
        }}
      >
        <option value="">Choose a mounted location</option>
        {#each roots as location}<option value={location}>{location}</option>{/each}
      </select>
      <small>Only locations mounted into Manager are available. A new private media folder is created there.</small>
    </label>
    <button class="button quiet mt16" disabled={disabled || busy || !root} onclick={check}>Check this drive</button>
    {#if review}
      {#if !review.available}<p class="notice warning mt16" role="status">
          This server cannot yet confirm that all uploads and jobs have safely stopped. Moving is unavailable; nothing
          was stopped or moved.
        </p>{/if}
      <p class="mt16">{review.files.toLocaleString()} files · {formatBytes(review.bytes)} to copy</p>
      <p class="meta">
        Frameleaf will be unavailable while the move runs. Uploads and background writers are stopped. A verified
        database recovery point is saved first.
      </p>
      <label class="check-row mt16"
        ><input type="checkbox" bind:checked={accepted} disabled={disabled || busy} />
        <span
          >I have a separate backup of my photos and videos, and understand that returning to the old folder after new
          writes requires another verified move.</span
        >
      </label>
      <div class="actions mt16">
        <button class="button primary" disabled={disabled || busy || !accepted || !review.available} onclick={move}
          >Move the library</button
        >
        <button
          class="button quiet"
          disabled={busy}
          onclick={() => {
            review = null;
            accepted = false;
          }}>Cancel</button
        >
      </div>
    {/if}
    {#if error}<p class="notice warning mt16" role="alert">{error}</p>{/if}
    {#if roots.length === 0}<p class="notice warning mt16">
        No destination is mounted into Manager. Add an approved drive mount before moving.
      </p>{/if}
  </div>
</section>
