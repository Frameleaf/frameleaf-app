<script lang="ts">
  // FL-1476 (proposed): Updates says which version is running and, when one is ready, what's in it and exactly
  // what happens when it's installed. Reviewing it still goes through Manager's verified review-update.
  import Icon from './Icon.svelte';
  import { releaseNotesText } from './presentation';
  import { when } from './OverviewPage.svelte';

  let { current, available, checkedAt, autoUpdate, autoUpdateFailure, disabled, check, review, setAuto } = $props<{
    current: string;
    available: { tag: string; publishedAt: string; notes?: string }[];
    checkedAt: number | null;
    autoUpdate: boolean;
    autoUpdateFailure: string | null;
    disabled: boolean;
    check: () => void;
    review: (tag: string) => void;
    setAuto: (enabled: boolean) => void;
  }>();

  const version = (tag: string) => tag.replace(/^frameleaf-v?/, '');
  const next = $derived(available[0]);
  const others = $derived(available.slice(1));
</script>

<section class="card up-status" data-tone={next ? 'info' : 'good'} aria-labelledby="up-status-title">
  <div class="up-status-body">
    <span class="up-mark"><Icon name={next ? 'update' : 'check'} /></span>
    <div>
      <span class="up-eyebrow">Frameleaf on this server</span>
      <h2 id="up-status-title">{next ? `${version(next.tag)} is ready` : `You’re on the latest version`}</h2>
      <p class="meta">You’re on {version(current)}.{checkedAt ? ` Checked ${when(checkedAt).replace(/^(Just now|Today|Last night|Yesterday)/, (w) => w.toLowerCase())}.` : ''}</p>
    </div>
    <button class="button quiet" {disabled} onclick={check}><Icon name="refresh" />Check now</button>
  </div>
</section>

{#if next}
  <section class="card mt16" aria-labelledby="up-next-title">
    <div class="card-header"><div><h2 id="up-next-title">What’s new in {version(next.tag)}</h2><p class="meta">Released {when(next.publishedAt).replace(/^(Today|Last night|Yesterday)/, (w) => w.toLowerCase())}</p></div></div>
    {#if next.notes}<div class="card-body up-notes">{releaseNotesText(next.notes)}</div>{/if}
    <div class="card-body up-steps-wrap">
      <h3>What happens when you install it</h3>
      <ol class="up-steps">
        <li><span>1</span><div><strong>Manager makes a recovery point</strong><p>So the database can go back exactly as it is now.</p></div></li>
        <li><span>2</span><div><strong>It downloads and checks {version(next.tag)}</strong><p>Only signed versions made for this server are installed.</p></div></li>
        <li><span>3</span><div><strong>Frameleaf restarts</strong><p>Photos pause for a few minutes. Your files aren’t touched.</p></div></li>
        <li><span>4</span><div><strong>If it doesn’t start, you can go back</strong><p>Manager keeps {version(current)} and the recovery point until the new version is running.</p></div></li>
      </ol>
    </div>
    <div class="card-footer up-footer"><button class="button primary" {disabled} onclick={() => review(next.tag)}>Review this update</button></div>
  </section>
  {#if others.length}
    <details class="card mt16 up-others">
      <summary>Other versions you can install · {others.length}</summary>
      {#each others as release (release.tag)}
        <div class="list-row"><Icon name="update" /><div><strong>{version(release.tag)}</strong><p>Released {when(release.publishedAt)}</p></div><button class="button quiet" {disabled} onclick={() => review(release.tag)}>Review</button></div>
      {/each}
    </details>
  {/if}
{/if}

<section class="card mt16" aria-labelledby="up-auto-title">
  <div class="list-row">
    <Icon name="clock" />
    <div>
      <strong id="up-auto-title">Install updates automatically</strong>
      <p>Manager checks every few hours and installs one version at a time, each after a recovery point. Off means updates wait for you here.</p>
      {#if autoUpdateFailure}<p class="up-failure" role="status"><Icon name="warning" />{autoUpdateFailure}</p>{/if}
    </div>
    <label class="toggle"><input type="checkbox" aria-labelledby="up-auto-title" checked={autoUpdate} {disabled} onchange={(e) => setAuto(e.currentTarget.checked)} /><span class="toggle-track"></span><span>{autoUpdate ? 'On' : 'Off'}</span></label>
  </div>
</section>

<style>
  .up-status-body { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 20px; }
  .up-mark { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 13px; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--panel)); }
  .up-mark :global(svg) { width: 22px; height: 22px; }
  .up-status[data-tone='info'] { border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); }
  .up-eyebrow { font-size: 12px; color: var(--muted); }
  .up-status h2 { font-size: 22px; letter-spacing: -0.4px; margin: 2px 0 4px; }
  .up-status .meta { font-size: 14px; }
  .card-header .meta { margin-top: 4px; font-size: 13px; }
  .up-notes { white-space: pre-wrap; font-size: 14px; line-height: 1.6; color: var(--text); border-top: 1px solid var(--border); }
  .up-steps-wrap { border-top: 1px solid var(--border); }
  .up-steps-wrap h3 { font-size: 14px; font-weight: 500; margin-bottom: 14px; }
  .up-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
  .up-steps li { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 12px; font-size: 14px; }
  .up-steps li > span { display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; color: var(--accent); }
  .up-steps strong { font-weight: 500; }
  .up-steps p { font-size: 13px; color: var(--muted); margin-top: 2px; }
  .up-footer { display: flex; justify-content: flex-end; padding: 14px 20px; border-top: 1px solid var(--border); }
  .up-others > summary { padding: 16px 20px; cursor: pointer; font-size: 14px; color: var(--muted); }
  .up-others .list-row { border-top: 1px solid var(--border); }
  .up-failure { display: flex; gap: 6px; align-items: center; color: var(--amber) !important; }
  .up-failure :global(svg) { width: 14px; height: 14px; }
  .button { display: inline-flex; align-items: center; gap: 8px; }
  .button :global(svg) { width: 15px; height: 15px; }
  @media (max-width: 640px) {
    .up-status-body { grid-template-columns: auto minmax(0, 1fr); }
    .up-status-body > .button { grid-column: 1 / -1; justify-content: center; }
    .up-footer .button { width: 100%; justify-content: center; }
  }
</style>
