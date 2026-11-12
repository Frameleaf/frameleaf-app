<script lang="ts" module>
  /** "Last night, 2:00", "Today, 14:05", "Tuesday, 2:00", "3 Nov": how long ago without making people do date maths. */
  export function when(time: string | number, now = Date.now()) {
    const date = new Date(time);
    const clock = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((day(new Date(now)) - day(date)) / 86_400_000);
    if (days === 0) return date.getHours() < 6 ? `Last night, ${clock}` : `Today, ${clock}`;
    if (days === 1) return date.getHours() >= 18 || date.getHours() < 6 ? `Last night, ${clock}` : `Yesterday, ${clock}`;
    if (days < 7) return `${date.toLocaleDateString([], { weekday: 'long' })}, ${clock}`;
    return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
  }
  export const ageDays = (time: string | number, now = Date.now()) => (now - new Date(time).getTime()) / 86_400_000;
</script>

<script lang="ts">
  // FL-1476 (proposed): Overview leads with what needs you, then the library, the address, the services and
  // the server. Everything links to the page that fixes it.
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { formatBytes } from './presentation';
  import { CONTAINERS, fromApi, hostOf, suggestionsFor, summary, type ApiOverride, type ContainerId } from './container-catalog';

  let { dashboard, installation, storage, snapshots, updates, running, healthy, api, go } = $props<{
    dashboard: any;
    installation: any;
    storage: { path: string; uses: string[]; totalBytes: number | null; availableBytes: number | null; lowOnSpace: boolean | null }[];
    snapshots: { time: string }[];
    updates: { loaded: boolean; available: { tag: string }[] };
    running: boolean;
    healthy: boolean;
    api: (path: string, body?: unknown) => Promise<any>;
    go: (screen: string, tab?: ContainerId) => void;
  }>();

  let containers = $state<{ services: Record<string, ApiOverride>; outside?: Record<string, ApiOverride> } | null>(null);
  let copied = $state(false);
  onMount(async () => {
    containers = await api('container-settings').catch(() => null);
  });

  const host = $derived(hostOf(dashboard.host));
  const latest = $derived(snapshots[0]);
  const media = $derived(storage.find((s) => s.uses.includes('media')));
  const usedShare = (s: { totalBytes: number | null; availableBytes: number | null } | undefined) =>
    s?.totalBytes && s.availableBytes != null ? Math.round(((s.totalBytes - s.availableBytes) / s.totalBytes) * 100) : null;
  const STATE: Record<string, string> = { 'frameleaf-server': 'Frameleaf server', 'frameleaf-machine-learning': 'Machine learning', database: 'Database' };

  type Item = { tone: 'warning' | 'error' | 'info'; icon: string; title: string; detail: string; action: string; screen: string; tab?: ContainerId };
  /** Everything that needs the owner, worst first. Each one names the page that fixes it. */
  const attention = $derived.by(() => {
    const items: Item[] = [];
    for (const service of dashboard.services ?? [])
      if (!service.running || service.health === 'unhealthy')
        items.push({ tone: 'error', icon: 'warning', title: `${STATE[service.service] ?? service.service} isn’t ${service.running ? 'answering' : 'running'}`, detail: 'Its logs on Services usually say why.', action: 'Open Services', screen: 'services' });
    for (const place of storage)
      if (place.lowOnSpace || (usedShare(place) ?? 0) >= 90)
        items.push({
          tone: 'warning',
          icon: 'drive',
          title: `The ${place.uses.includes('media') ? 'photos' : place.uses.includes('database') ? 'database' : place.uses[0]} drive is ${usedShare(place)}% full`,
          detail: `${formatBytes(place.availableBytes)} left. Move it to a bigger drive before it runs out.`,
          action: 'Open Storage',
          screen: 'storage',
        });
    if (!latest) items.push({ tone: 'warning', icon: 'shield', title: 'No recovery point yet', detail: 'Make one now so the database can be put back if something goes wrong.', action: 'Open Backups', screen: 'backups' });
    else if (ageDays(latest.time) > 2)
      items.push({ tone: 'warning', icon: 'shield', title: `No recovery point since ${when(latest.time)}`, detail: 'The nightly backup hasn’t run. Check Backups.', action: 'Open Backups', screen: 'backups' });
    for (const [id, override] of Object.entries(containers?.outside ?? {}))
      if (Object.keys(override.environment ?? {}).length || override.mounts?.length)
        items.push({ tone: 'warning', icon: 'box', title: `${STATE[id]} was changed in Docker or Unraid`, detail: 'The next update removes those changes unless you keep them in Manager.', action: 'Review on Containers', screen: 'containers', tab: id as ContainerId });
    if (updates.available.length)
      items.push({ tone: 'info', icon: 'update', title: `Frameleaf ${updates.available[0].tag.replace(/^frameleaf-v?/, '')} is ready`, detail: `You’re on ${installation.release.replace(/^frameleaf-v?/, '')}. Manager saves a recovery point first.`, action: 'Open Updates', screen: 'updates' });
    if (host && containers) {
      const count = CONTAINERS.reduce((n, c) => {
        const env = new Map(Object.entries(containers!.services[c.id]?.environment ?? {}));
        return n + suggestionsFor(host!, c.id).filter((s) => env.get(s.name) !== s.value).length;
      }, 0);
      if (count) items.push({ tone: 'info', icon: 'bulb', title: `${count} ${count === 1 ? 'setting suits' : 'settings suit'} this server better than the defaults`, detail: `Manager found ${host.cores} cores and ${host.memoryGb} GB.`, action: 'See suggestions', screen: 'containers' });
    }
    return items;
  });
  const problems = $derived(attention.filter((i) => i.tone !== 'info').length);
  const address = $derived(dashboard.appUrl as string);
  async function copy() {
    await navigator.clipboard?.writeText(address).catch(() => undefined);
    copied = true;
    setTimeout(() => (copied = false), 1600);
  }
</script>

<section class="card ov-status" data-tone={!running ? 'error' : problems ? 'warning' : 'good'} aria-labelledby="ov-status-title">
  <div class="card-header">
    <div class="ov-status-head">
      <span class="ov-status-mark"><Icon name={!running ? 'stop' : problems ? 'warning' : 'check'} /></span>
      <div>
        <h2 id="ov-status-title">{!running ? 'Frameleaf is stopped' : problems ? `${problems} ${problems === 1 ? 'thing needs' : 'things need'} you` : 'Everything is running'}</h2>
        <p class="meta">{!running ? 'Start it on Services to open your library.' : problems ? 'Your photos are safe. Each item says where to fix it.' : healthy ? 'Nothing needs you right now.' : 'Services are still starting.'}</p>
      </div>
    </div>
  </div>
  {#each attention as item (item.title)}
    <div class="list-row ov-item" data-tone={item.tone}>
      <Icon name={item.icon} />
      <div><strong>{item.title}</strong><p>{item.detail}</p></div>
      <button class="button quiet" onclick={() => go(item.screen, item.tab)}>{item.action}</button>
    </div>
  {/each}
</section>

<div class="metric-grid mt16">
  <section class="card metric">
    <span class="label"><Icon name="image" />Photos & videos</span>
    <strong>{dashboard.summary?.assets?.toLocaleString() ?? 'Unavailable'}</strong>
    <small>{dashboard.summary ? `${dashboard.summary.albums} albums · ${dashboard.summary.users} ${dashboard.summary.users === 1 ? 'account' : 'accounts'}` : 'Counts appear once the database answers'}</small>
  </section>
  <section class="card metric">
    <span class="label"><Icon name="drive" />Photos drive</span>
    <strong>{formatBytes(media?.availableBytes)} free</strong>
    {#if usedShare(media) !== null}<span class="meter" aria-hidden="true"><span style="width: {usedShare(media)}%" class:warn={(usedShare(media) ?? 0) >= 90}></span></span>{/if}
    <small>{media?.totalBytes ? `${usedShare(media)}% of ${formatBytes(media.totalBytes)} used` : 'Size unknown'} · <button class="text-button" onclick={() => go('storage')}>Storage</button></small>
  </section>
  <section class="card metric">
    <span class="label"><Icon name="shield" />Last recovery point</span>
    <strong>{latest ? when(latest.time) : 'None yet'}</strong>
    <small>{latest ? `${snapshots.length} kept · database only` : 'Make one on Backups'} · <button class="text-button" onclick={() => go('backups')}>Backups</button></small>
  </section>
</div>

<section class="card mt16" aria-labelledby="ov-address-title">
  <div class="list-row">
    <Icon name="network" />
    <div><strong id="ov-address-title">Frameleaf’s address</strong><p><a href={address} target="_blank" rel="noreferrer">{address}</a> · phones and other computers at home use this.</p></div>
    <button class="button quiet" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
  </div>
</section>

<section class="card mt16" aria-labelledby="ov-services-title">
  <div class="card-header"><h2 id="ov-services-title">Services</h2><button class="button quiet" onclick={() => go('services')}>Manage</button></div>
  {#each dashboard.services ?? [] as service (service.id)}
    {@const id = service.service as ContainerId}
    {@const extra = containers ? summary(fromApi(containers.services[id])) : ''}
    <div class="list-row">
      <Icon name={id === 'database' ? 'database' : id === 'frameleaf-machine-learning' ? 'cpu' : 'server'} />
      <div><strong>{STATE[id] ?? id}</strong><p>{id === 'frameleaf-server' ? installation.release : id === 'database' ? 'PostgreSQL' : 'Faces and smart search'}{extra ? ` · ${extra}` : ''}</p></div>
      <span class="badge" class:good={service.running && service.health === 'healthy'} class:warning={service.health === 'unhealthy' || !service.running}>{!service.running ? 'Stopped' : service.health === 'unhealthy' ? 'Not answering' : service.health === 'healthy' ? 'Ready' : 'Starting'}</span>
      {#if STATE[id]}<button class="button quiet" aria-label="Edit {STATE[id]} settings" onclick={() => go('containers', id)}><Icon name="edit" />Edit</button>{/if}
    </div>
  {/each}
  {#if !installation.ml}<div class="list-row"><Icon name="cpu" /><div><strong>Machine learning</strong><p>Off. Faces and smart search need it.</p></div><span class="badge">Off</span></div>{/if}
</section>

<div class="two-cols mt16">
  <section class="card"><div class="card-body">
    <div class="row mb16"><Icon name="shield" /><h2>Recovery points</h2></div>
    <p class="muted">{latest ? `${snapshots.length} ${snapshots.length === 1 ? 'recovery point' : 'recovery points'}, the newest from ${when(latest.time).replace(/^(Last|Today|Yesterday)/, (w) => w.toLowerCase())}.` : 'None yet.'} They hold the database: albums, people, edits and settings. Your photos stay where they are.</p>
    <button class="text-button mt16" onclick={() => go('backups')}>Open Backups</button>
  </div></section>
  <section class="card"><div class="card-body">
    <div class="row mb16"><Icon name="update" /><h2>{!updates.loaded ? 'Updates' : updates.available.length ? 'An update is ready' : 'Up to date'}</h2></div>
    <p class="muted">{updates.available.length ? `Frameleaf ${updates.available[0].tag.replace(/^frameleaf-v?/, '')} is ready. You’re on ${installation.release.replace(/^frameleaf-v?/, '')}.` : `You’re on Frameleaf ${installation.release.replace(/^frameleaf-v?/, '')}.`} Updates only install when you choose.</p>
    <button class="text-button mt16" onclick={() => go('updates')}>Open Updates</button>
  </div></section>
</div>

<style>
  .ov-status-head { display: flex; gap: 14px; align-items: flex-start; }
  .ov-status-head h2 { font-size: 18px; }
  .ov-status-head .meta { margin-top: 4px; font-size: 14px; }
  .ov-status-mark { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; border-radius: 11px; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--panel)); }
  .ov-status-mark :global(svg) { width: 18px; height: 18px; }
  .ov-status[data-tone='warning'] .ov-status-mark { color: var(--amber); background: color-mix(in srgb, var(--amber) 12%, var(--panel)); }
  .ov-status[data-tone='error'] .ov-status-mark { color: var(--red); background: color-mix(in srgb, var(--red) 12%, var(--panel)); }
  .ov-status[data-tone='good'] { border-color: color-mix(in srgb, var(--accent) 25%, var(--border)); }
  .ov-status[data-tone='warning'] { border-color: color-mix(in srgb, var(--amber) 30%, var(--border)); }
  .ov-item { border-top: 1px solid var(--border); }
  .ov-item[data-tone='warning'] > :global(svg) { color: var(--amber); }
  .ov-item[data-tone='error'] > :global(svg) { color: var(--red); }
  .ov-item[data-tone='info'] > :global(svg) { color: var(--accent); }
  .metric small .text-button { font-size: inherit; color: var(--accent); }
  .meter { display: block; height: 6px; margin: 10px 0 8px; border-radius: 6px; background: var(--raised); overflow: hidden; }
  .meter > span { display: block; height: 100%; background: var(--accent); }
  .meter > span.warn { background: var(--amber); }
  .list-row .button { display: inline-flex; align-items: center; gap: 8px; }
  .list-row .button :global(svg) { width: 15px; height: 15px; }
  .list-row p a { color: var(--accent); }
  @media (max-width: 640px) {
    .ov-item { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px 12px; align-items: start; }
    .ov-item > :global(svg) { margin-top: 2px; }
    .ov-item .button { grid-column: 2; justify-self: start; }
  }
</style>
