<script lang="ts">
  /**
   * About Frameleaf (S-4): the prototype's `About` (`design/frameleaf/template/src/SystemPanels.jsx:
   * 317-431`) — the symbol with product and version, a facts grid, the Immich attribution, version
   * history and Done — in place of the upstream modal and its `ServerAboutItem` grid (which titled a
   * row "Immich"). The facts are what this server reports: version, build, server, runtime, media
   * tools, licence and source.
   *
   * "Check for updates" (FL-80 S-4, `SystemPanels.jsx:331-344, 366-369, 404-419`) asks Frameleaf's
   * own release feed through the server (owner decision on FL-146, 2026-09-25: the privacy direction
   * applied only to Immich-origin calls). An administrator's check runs now; any other account sees
   * the server's last recorded check. A newer version links to its GitHub release notes.
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { checkForUpdates, releaseNotesUrl, type UpdateCheckResult } from '$lib/frameleaf/version-check';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { type ServerAboutResponseDto, type ServerVersionHistoryResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAlertOutline, mdiCheckCircle, mdiInformationOutline, mdiProgressClock, mdiUpdate } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  // FL-135: the symbol is imported unmodified from the authorized brand kit (never redrawn);
  // see docs/docs/developer/frameleaf-plan/06-brand-assets.md.
  import symbolUrl from '$lib/assets/frameleaf/frameleaf-symbol.svg?url';

  type Props = {
    onClose: () => void;
    info: ServerAboutResponseDto;
    versions: ServerVersionHistoryResponseDto[];
  };

  const { onClose, info, versions }: Props = $props();

  let open = $state(true);
  $effect(() => {
    if (!open) {
      onClose();
    }
  });

  const licenceUrl = 'https://github.com/immich-app/immich/blob/main/LICENSE';

  type Fact = { label: string; value?: string; href?: string; code?: boolean };
  const facts: Fact[] = $derived(
    (
      [
        { label: $t('version'), value: info.version, href: info.versionUrl || undefined },
        { label: $t('build'), value: info.build, href: info.buildUrl, code: true },
        { label: $t('frameleaf_about_server'), value: location.host },
        { label: $t('frameleaf_about_runtime'), value: info.nodejs && `Node.js ${info.nodejs}` },
        {
          label: $t('frameleaf_about_media_tools'),
          value: [
            info.libvips && `libvips ${info.libvips}`,
            info.ffmpeg && `FFmpeg ${info.ffmpeg}`,
            info.exiftool && `ExifTool ${info.exiftool}`,
          ]
            .filter(Boolean)
            .join(' · '),
        },
        { label: $t('frameleaf_about_licence'), value: 'AGPL-3.0', href: licenceUrl },
        { label: $t('repository'), value: info.repository, href: info.repositoryUrl },
        {
          label: $t('source'),
          value: info.sourceRef && info.sourceCommit ? `${info.sourceRef}@${info.sourceCommit.slice(0, 9)}` : undefined,
          href: info.sourceUrl,
          code: true,
        },
      ] satisfies Fact[]
    ).filter((fact) => fact.value),
  );

  let checking = $state(false);
  let result = $state<UpdateCheckResult | 'failed' | undefined>();
  const check = async () => {
    if (checking) {
      return;
    }
    checking = true;
    result = undefined;
    try {
      result = await checkForUpdates(authManager.user.isAdmin, info.version);
    } catch {
      result = 'failed';
    } finally {
      checking = false;
    }
  };
  const checkedWhen = (iso: string | undefined) =>
    (iso && DateTime.fromISO(iso).toRelative({ locale: $locale })) || $t('frameleaf_about_update_just_now');

  const longDate = (iso: string) =>
    DateTime.fromISO(iso).toLocaleString({ day: 'numeric', month: 'short', year: 'numeric' }, { locale: $locale });
</script>

<Dialog title={$t('frameleaf_about_menu_item')} closeLabel={$t('close')} bind:open>
  <div class="about-head">
    <img src={symbolUrl} alt="" width="52" height="52" />
    <div>
      <strong>Frameleaf</strong>
      <span>
        {$t('frameleaf_about_version', { values: { version: info.version } })}{info.build ? ` · ${info.build}` : ''}
      </span>
    </div>
  </div>
  <dl class="about-facts">
    {#each facts as fact (fact.label)}
      <div>
        <dt>{fact.label}</dt>
        <dd>
          {#if fact.href}
            <a href={fact.href} target="_blank" rel="noreferrer">
              {#if fact.code}<code>{fact.value}</code>{:else}{fact.value}{/if}
            </a>
          {:else if fact.code}
            <code>{fact.value}</code>
          {:else}
            {fact.value}
          {/if}
        </dd>
      </div>
    {/each}
  </dl>
  {#if info.sourceRef === 'main' && info.repository === 'Frameleaf/frameleaf-app'}
    <p class="about-attribution warning">
      <Icon icon={mdiAlertOutline} size="16" aria-hidden={true} />
      <span>{$t('main_branch_warning')}</span>
    </p>
  {/if}
  <p class="about-attribution">
    <Icon icon={mdiInformationOutline} size="16" aria-hidden={true} />
    <span>
      <FormatMessage key="frameleaf_about_attribution">
        {#snippet children({ tag, message })}
          {#if tag === 'upstream'}
            <a href="https://github.com/immich-app/immich" target="_blank" rel="noopener noreferrer">{message}</a>
          {:else if tag === 'licence'}
            <a href={licenceUrl} target="_blank" rel="noopener noreferrer">{message}</a>
          {:else}
            {message}
          {/if}
        {/snippet}
      </FormatMessage>
    </span>
  </p>
  <div
    class="about-check"
    class:ok={result && result !== 'failed' && result.status === 'current'}
    class:available={result && result !== 'failed' && result.status === 'available'}
    role="status"
    aria-live="polite"
  >
    {#if checking}
      <Icon icon={mdiProgressClock} size="16" aria-hidden={true} />
      {$t('frameleaf_about_update_checking')}
    {:else if result === 'failed'}
      <Icon icon={mdiAlertOutline} size="16" aria-hidden={true} />
      {$t('frameleaf_about_update_failed')}
    {:else if result?.status === 'current'}
      <Icon icon={mdiCheckCircle} size="16" aria-hidden={true} />
      {$t('frameleaf_about_update_current', { values: { when: checkedWhen(result.checkedAt) } })}
    {:else if result?.status === 'available'}
      <Icon icon={mdiUpdate} size="16" aria-hidden={true} />
      <span>
        {$t('frameleaf_about_update_available', {
          values: { version: result.version, when: checkedWhen(result.checkedAt) },
        })}
        <a href={releaseNotesUrl(result.version)} target="_blank" rel="noopener noreferrer"
          >{$t('frameleaf_about_update_release_notes')}</a
        >
      </span>
    {:else if result?.status === 'unknown'}
      <Icon icon={mdiInformationOutline} size="16" aria-hidden={true} />
      {$t('frameleaf_about_update_unknown')}
    {/if}
  </div>
  {#if versions.length > 0}
    <section class="about-history" aria-labelledby="fl-about-history-title">
      <h3 id="fl-about-history-title">{$t('version_history')}</h3>
      <ol>
        {#each versions.slice(0, 5) as item (item.id)}
          <li>
            <div>
              <strong>{item.version}</strong>
              <time datetime={item.createdAt}>{longDate(item.createdAt)}</time>
            </div>
          </li>
        {/each}
      </ol>
    </section>
  {/if}
  {#snippet actions()}
    <button type="button" class="button" disabled={checking} onclick={check}>
      <Icon icon={mdiUpdate} size="16" aria-hidden={true} />
      {checking ? $t('frameleaf_about_checking') : $t('frameleaf_about_check_for_updates')}
    </button>
    <button type="button" class="button primary" data-initial-focus onclick={() => (open = false)}>
      {$t('done')}
    </button>
  {/snippet}
</Dialog>

<style>
  /* design/frameleaf/template/src/system.css `.about-*`. */
  .about-head {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 18px;
  }
  .about-head strong {
    font-size: 19px;
    letter-spacing: -0.4px;
    display: block;
  }
  .about-head span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .about-facts {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 16px;
    padding: 14px;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .about-facts div {
    display: grid;
    gap: 1px;
    min-width: 0;
  }
  .about-facts dt {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .about-facts dd {
    margin: 0;
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
  .about-facts a {
    color: var(--fl-text);
  }
  .about-facts code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--fl-font-small);
  }
  .about-attribution {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin: 14px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .about-attribution :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
  }
  .about-attribution.warning :global(svg) {
    color: var(--fl-warning);
  }
  .about-attribution a {
    color: var(--fl-text);
  }
  .about-check {
    margin-top: 14px;
    min-height: 20px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .about-check.ok :global(svg) {
    color: var(--fl-teal);
  }
  .about-check.available :global(svg) {
    color: var(--fl-blue);
  }
  .about-check a {
    color: var(--fl-text);
  }
  .about-history {
    margin-top: 18px;
    display: grid;
    gap: 10px;
  }
  .about-history h3 {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .about-history ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .about-history li {
    padding: 12px 0;
    border-top: 1px solid var(--fl-border);
  }
  .about-history li > div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .about-history li strong {
    font-weight: 600;
  }
  .about-history time {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  @media (max-width: 700px) {
    .about-facts {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
