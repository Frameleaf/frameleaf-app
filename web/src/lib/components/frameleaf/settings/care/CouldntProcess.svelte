<script lang="ts">
  /**
   * Library care › Things to fix › Couldn't process (FL-862, after the approved prototype
   * `settings-v2/care/doctor.jsx` CouldntProcess, FL-773): the photos and videos Frameleaf could not
   * finish (FL-845), in plain words, with Try again, Download original and Keep as is. Every account
   * opens it: a member sees their own files, an administrator the household's with whose each is.
   *
   * A file another account owns shows a lock, not its picture, and has no download: Library care
   * never shows one account another's pictures (FL-1338). The administrator can still try it again or
   * keep it as it is, which the server allows, and open what the server recorded about it.
   *
   * After Try again the row says "Trying again…" and the list is read again every few seconds until
   * no file is being tried; a file that works leaves the list by itself.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import {
    actionItems,
    causeWords,
    FAILURES_PAGE,
    groupFailures,
    isRetrying,
    SET_ASIDE_AFTER,
    stepWords,
    type ProcessingFailureFile,
  } from '$lib/frameleaf/processing-failures';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { downloadUrl, getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    dismissProcessingFailures,
    getProcessingFailures,
    retryProcessingFailures,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheckCircleOutline,
    mdiCloudAlertOutline,
    mdiDownloadOutline,
    mdiFileAlertOutline,
    mdiFileClockOutline,
    mdiFileQuestionOutline,
    mdiLockOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  /** How often the list is read again while a file is being tried. */
  const POLL_MS = 5000;

  const me = $derived(authManager.user.id);
  const isAdmin = $derived(authManager.user.isAdmin);

  let files = $state<ProcessingFailureFile[]>([]);
  let status = $state<'loading' | 'ready' | 'error'>('loading');
  let busy = $state<string | null>(null);
  /** Files sent to try again from this page, shown as being tried until the list says otherwise. */
  let trying = $state<string[]>([]);
  let said = $state('');
  let whose = $state('');
  let poll: ReturnType<typeof setTimeout> | undefined;
  let alive = true;

  const load = async () => {
    try {
      files = groupFailures(await getProcessingFailures({ take: FAILURES_PAGE }));
      status = 'ready';
      // a file that left the list, or failed again, is no longer being tried
      trying = trying.filter((id) => files.some((file) => file.assetId === id && isRetrying(file)));
    } catch {
      if (status !== 'ready') {
        status = 'error';
      }
    }
    clearTimeout(poll);
    if (alive && files.some((file) => isRetrying(file) || trying.includes(file.assetId))) {
      poll = setTimeout(() => void load(), POLL_MS);
    }
  };

  void load();
  onDestroy(() => {
    alive = false;
    clearTimeout(poll);
  });

  const owners = $derived(
    [...new Map(files.map((file) => [file.ownerId, file.ownerName]))].sort(([, a], [, b]) => a.localeCompare(b)),
  );
  const shown = $derived(whose ? files.filter((file) => file.ownerId === whose) : files);
  const setAside = $derived(shown.filter((file) => file.setAside && !isRetrying(file)).length);

  const hero = $derived.by(() => {
    if (status === 'error') {
      return {
        tone: 'warn' as const,
        icon: mdiCloudAlertOutline,
        title: $t('frameleaf_processing_failure_load_failed'),
        body: $t('frameleaf_processing_failure_load_failed_body'),
      };
    }
    if (status === 'loading') {
      return { tone: 'quiet' as const, icon: mdiFileClockOutline, title: $t('frameleaf_processing_failure_loading') };
    }
    if (shown.length > 0) {
      return {
        tone: 'warn' as const,
        icon: mdiFileAlertOutline,
        title: $t('frameleaf_processing_failure_hero', { values: { count: shown.length } }),
        body: setAside
          ? $t('frameleaf_processing_failure_hero_body_aside', { values: { count: setAside, tries: SET_ASIDE_AFTER } })
          : $t('frameleaf_processing_failure_hero_body', { values: { tries: SET_ASIDE_AFTER } }),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiCheckCircleOutline,
      title: $t('frameleaf_processing_failure_hero_none'),
      body: $t('frameleaf_processing_failure_hero_none_body'),
    };
  });

  const when = (value: string) => {
    const date = DateTime.fromISO(value).setLocale($locale ?? 'en');
    const days = Math.floor(DateTime.now().startOf('day').diff(date.startOf('day'), 'days').days);
    if (days === 0) {
      return $t('frameleaf_processing_failure_today', { values: { time: date.toLocaleString(DateTime.TIME_SIMPLE) } });
    }
    if (days === 1) {
      return $t('frameleaf_processing_failure_yesterday');
    }
    return date.toLocaleString({ month: 'short', day: 'numeric' });
  };

  const tryAgain = async (file: ProcessingFailureFile) => {
    busy = file.assetId;
    try {
      await retryProcessingFailures({ processingFailureActionDto: { items: actionItems([file]) } });
      trying = [...trying, file.assetId];
      said = $t('frameleaf_processing_failure_retried', { values: { name: file.fileName } });
      await load();
    } catch (error) {
      handleError(error, $t('frameleaf_processing_failure_action_failed'));
    } finally {
      busy = null;
    }
  };

  const keep = async (file: ProcessingFailureFile) => {
    busy = file.assetId;
    try {
      await dismissProcessingFailures({ processingFailureActionDto: { items: actionItems([file]) } });
      files = files.filter((row) => row.assetId !== file.assetId);
      said = $t('frameleaf_processing_failure_kept', { values: { name: file.fileName } });
    } catch (error) {
      handleError(error, $t('frameleaf_processing_failure_action_failed'));
    } finally {
      busy = null;
    }
  };

  const download = (file: ProcessingFailureFile) =>
    downloadUrl(getAssetMediaUrl({ id: file.assetId, size: AssetMediaSize.Original }), file.fileName);

  /** A picture that can't be shown (the previews are what failed) leaves the icon tile. */
  const hideBroken = (event: Event) => {
    (event.currentTarget as HTMLImageElement).hidden = true;
  };
</script>

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />

  {#if status === 'error'}
    <Hero
      tone={hero.tone}
      icon={hero.icon}
      title={hero.title}
      body={hero.body}
      label={$t('frameleaf_cc_section_couldnt_process')}
    >
      {#snippet actions()}
        <Button variant="primary" onclick={() => void load()}>{$t('frameleaf_processing_failure_try_load')}</Button>
      {/snippet}
    </Hero>
  {:else}
    <Hero
      tone={hero.tone}
      icon={hero.icon}
      title={hero.title}
      body={hero.body}
      label={$t('frameleaf_cc_section_couldnt_process')}
    />
  {/if}

  {#if status === 'loading'}
    <Section title={$t('frameleaf_processing_failure_files')}>
      <ul class="failures is-loading" aria-busy="true">
        {#each [0, 1, 2] as row (row)}
          <li><span class="picture"></span><span class="bar"></span><span class="bar is-short"></span></li>
        {/each}
      </ul>
    </Section>
  {:else if status === 'ready' && files.length > 0}
    <Section
      title={$t('frameleaf_processing_failure_files')}
      description={$t('frameleaf_processing_failure_files_description')}
    >
      {#snippet action()}
        {#if isAdmin && owners.length > 1}
          <div class="whose">
            <span aria-hidden="true">{$t('frameleaf_processing_failure_whose')}</span>
            <Select
              label={$t('frameleaf_processing_failure_whose')}
              value={whose}
              options={[
                { value: '', label: $t('frameleaf_processing_failure_everyone') },
                ...owners.map(([value, label]) => ({ value, label })),
              ]}
              onChange={(value) => (whose = value)}
            />
          </div>
        {/if}
      {/snippet}
      <ul class="failures" aria-label={$t('frameleaf_processing_failure_files')}>
        {#each shown as file (file.assetId)}
          {@const own = file.ownerId === me}
          {@const retrying = isRetrying(file) || trying.includes(file.assetId)}
          <li aria-busy={retrying}>
            {#if own}
              <span class="picture">
                <Icon icon={mdiFileQuestionOutline} size="24" aria-hidden />
                <img
                  src={getAssetMediaUrl({ id: file.assetId, size: AssetMediaSize.Thumbnail })}
                  alt=""
                  loading="lazy"
                  onerror={hideBroken}
                />
              </span>
            {:else}
              <!-- Another account's picture is never shown here: not even a request for it. -->
              <span
                class="picture"
                title={$t('frameleaf_processing_failure_private', { values: { owner: file.ownerName } })}
              >
                <Icon icon={mdiLockOutline} size="20" aria-hidden />
              </span>
            {/if}
            <div class="text">
              <strong>{$t(causeWords(file))}</strong>
              <span
                >{[file.fileName, isAdmin ? file.ownerName : undefined, when(file.lastFailedAt)]
                  .filter(Boolean)
                  .join(' · ')}</span
              >
              <span>{$t(stepWords(file.step))}</span>
              {#if retrying}
                <span class="aside">
                  <Pill tone="off">{$t('frameleaf_processing_failure_trying')}</Pill>
                  {$t('frameleaf_processing_failure_trying_body')}
                </span>
              {:else if file.setAside}
                <span class="aside">
                  <Pill tone="warn">{$t('frameleaf_processing_failure_set_aside')}</Pill>
                  {$t('frameleaf_processing_failure_set_aside_body', {
                    values: { count: Math.max(file.attempts, SET_ASIDE_AFTER) },
                  })}
                </span>
              {/if}
              {#if isAdmin}
                <span class="aside">
                  <TextLink href={commandCenterUrl('server', 'logs', { q: file.assetId })}>
                    {$t('frameleaf_processing_failure_logs')}
                  </TextLink>
                </span>
              {/if}
            </div>
            <div class="actions">
              <Button disabled={retrying || busy === file.assetId} onclick={() => void tryAgain(file)}>
                {$t('frameleaf_processing_failure_try_again')}
              </Button>
              {#if own}
                <Button onclick={() => download(file)}>
                  <Icon icon={mdiDownloadOutline} size="18" aria-hidden />
                  {$t('frameleaf_processing_failure_download')}
                </Button>
              {/if}
              <Button disabled={busy === file.assetId} onclick={() => void keep(file)}>
                {$t('frameleaf_processing_failure_keep')}
              </Button>
            </div>
          </li>
        {/each}
      </ul>
    </Section>
  {/if}

  <Section title={$t('frameleaf_processing_failure_explain_title')}>
    <p class="explain">{$t('frameleaf_processing_failure_explain', { values: { tries: SET_ASIDE_AFTER } })}</p>
  </Section>
</KitPage>

<style>
  .whose {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .failures {
    display: grid;
    margin: 0 0 var(--fl-space-2);
    padding: 0;
    list-style: none;
  }
  .failures li {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--fl-space-4) 20px;
    padding: 18px 0;
    border-top: 1px solid var(--fl-border);
  }
  .failures li:first-child {
    padding-top: var(--fl-space-1);
    border-top: 0;
  }
  .picture {
    position: relative;
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
    overflow: hidden;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-sm);
  }
  .picture img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .text {
    display: grid;
    gap: var(--fl-space-1);
    min-width: 0;
  }
  .text > span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .text .aside {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-1) var(--fl-space-3);
    margin-top: 6px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--fl-space-2);
    max-width: 360px;
  }
  .explain {
    max-width: 760px;
    margin: 0 0 var(--fl-space-5);
    color: var(--fl-muted);
    line-height: 1.55;
  }
  .is-loading li {
    grid-template-columns: 72px minmax(0, 1fr) minmax(0, 0.6fr);
    align-items: center;
  }
  .is-loading .picture,
  .bar {
    background: var(--fl-raised);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .bar {
    height: 14px;
    border-radius: var(--fl-radius-control);
  }
  .bar.is-short {
    width: 60%;
  }
  @keyframes pulse {
    50% {
      opacity: 0.45;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .is-loading .picture,
    .bar {
      animation: none;
    }
  }
  @container kit (max-width: 620px) {
    .failures li {
      grid-template-columns: 56px minmax(0, 1fr);
      gap: var(--fl-space-3) var(--fl-space-4);
    }
    .picture {
      width: 56px;
      height: 56px;
    }
    .actions {
      grid-column: 1 / -1;
      justify-content: flex-start;
      max-width: none;
    }
  }
</style>
