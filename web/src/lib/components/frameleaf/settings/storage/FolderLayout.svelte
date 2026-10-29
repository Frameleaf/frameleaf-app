<script lang="ts">
  /**
   * Storage & originals › Folder layout (FL-365, the approved prototype's
   * `settings-v2/library/layout.jsx`): how original files are named and sorted into folders on the
   * disk. A list of named layouts, each with an example, in place of a typed pattern; the pattern,
   * its placeholders and "Check files after moving them" stay under Advanced.
   *
   * Date layouts only (owner call defaulted on FL-365: no "By album" or "By camera"). A change applies
   * to new photos; "Re-file existing photos…" starts the storage migration that already exists and
   * says how many files it checks. Settings (`storageTemplate`) are saved with the settings bar.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Tiles from '$lib/components/frameleaf/settings/kit/Tiles.svelte';
  import { FOLDER_LAYOUTS, layoutOf, placeSample } from '$lib/components/frameleaf/settings/storage/storage';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import {
    getStorageMigrationStatus,
    runStorageMigrationInBackground,
    type StorageMigrationStatusResponseDto,
  } from '@frameleaf/sdk';
  import { mdiFolderCogOutline, mdiFolderOutline, mdiSync } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  const settingsDraft = getSystemConfigDraft();
  const draft = $derived(settingsDraft?.draft);
  const baseline = $derived(settingsDraft?.baseline);
  const disabled = $derived(featureFlagsManager.value.configFile || !draft);

  const sorted = $derived(draft?.storageTemplate.enabled ?? false);
  const template = $derived(draft?.storageTemplate.template ?? FOLDER_LAYOUTS[0].template);
  const layout = $derived(layoutOf(template));
  const savedTemplate = $derived(baseline?.storageTemplate.template ?? template);
  const savedLayout = $derived(layoutOf(savedTemplate));
  const savedSorted = $derived(baseline?.storageTemplate.enabled ?? false);
  const unsaved = $derived(template !== savedTemplate || sorted !== savedSorted);

  let status = $state<StorageMigrationStatusResponseDto | null>(null);
  let said = $state('');
  let timer: ReturnType<typeof setInterval> | undefined;
  const loadStatus = async () => {
    try {
      status = await getStorageMigrationStatus();
    } catch {
      status = null;
    }
  };
  onMount(() => {
    void loadStatus();
    timer = setInterval(() => {
      if (status?.isActive || status?.hasUnfinishedWork) {
        void loadStatus();
      }
    }, 5000);
    return () => clearInterval(timer);
  });

  const count = (value: number) => new Intl.NumberFormat($locale).format(value);
  const layoutName = (id: string) => $t(`frameleaf_layout_${id}` as Translations);
  const pathWords = (value: string) => placeSample(value).parts.join(' › ');
  const example = $derived(placeSample(template));
  const whole = $derived([$t('frameleaf_layout_sample_root'), $t('frameleaf_layout_sample_person'), ...example.parts]);
  const long = $derived(whole.join('/').length > 80);
  const refiling = $derived(!!status && (status.isActive || (status.hasUnfinishedWork && !status.isPaused)));

  const tiles = $derived([
    ...FOLDER_LAYOUTS.map((item) => ({
      id: item.id,
      name:
        item.id === 'day'
          ? $t('frameleaf_layout_recommended', { values: { name: layoutName(item.id) } })
          : layoutName(item.id),
      hint: pathWords(item.template),
    })),
    { id: 'custom', name: $t('frameleaf_layout_custom'), hint: $t('frameleaf_layout_custom_hint') },
  ]);
  const choose = (id: string) => {
    const chosen = FOLDER_LAYOUTS.find((item) => item.id === id);
    if (draft && chosen) {
      draft.storageTemplate.template = chosen.template;
    }
  };

  const refile = async () => {
    if (!status) {
      return;
    }
    const ok = await confirmFrameleaf({
      title: $t('frameleaf_layout_refile_title'),
      prompt: $t('frameleaf_layout_refile_prompt', {
        values: { count: count(status.candidates), path: pathWords(savedTemplate) },
      }),
      confirmText: $t('frameleaf_layout_refile_confirm', { values: { count: count(status.candidates) } }),
      cancelText: $t('frameleaf_layout_not_now'),
    });
    if (!ok) {
      return;
    }
    try {
      status = await runStorageMigrationInBackground();
      said = $t('frameleaf_layout_refile_started');
    } catch {
      said = $t('frameleaf_layout_refile_failed');
    }
  };

  const TERMS = ['y', 'MM', 'MMMM', 'dd', 'HH', 'filename', 'ext', 'album', 'slash'] as const;
</script>

<KitPage>
  {#if said}
    <Said message={said} onDismiss={() => (said = '')} />
  {/if}

  {#if refiling && status}
    <Hero
      tone="good"
      icon={mdiSync}
      label={$t('frameleaf_layout_status')}
      title={$t('frameleaf_layout_refiling')}
      body={$t('frameleaf_layout_refiling_body', {
        values: { done: count(status.statistics.completed), total: count(status.candidates) },
      })}
    />
  {:else}
    <Hero
      tone={savedSorted ? 'good' : 'quiet'}
      icon={savedSorted ? mdiFolderOutline : mdiFolderCogOutline}
      label={$t('frameleaf_layout_status')}
      title={savedSorted
        ? $t('frameleaf_layout_hero', {
            values: {
              layout:
                savedLayout === 'custom'
                  ? $t('frameleaf_layout_your_way')
                  : layoutName(savedLayout).toLocaleLowerCase($locale),
            },
          })
        : $t('frameleaf_layout_hero_off')}
      body={savedSorted
        ? $t('frameleaf_layout_hero_body', {
            values: {
              path: [
                $t('frameleaf_layout_sample_root'),
                $t('frameleaf_layout_sample_person'),
                ...placeSample(savedTemplate).parts,
              ].join(' › '),
            },
          })
        : $t('frameleaf_layout_hero_off_body')}
    />
  {/if}

  <Section title={$t('frameleaf_layout_how_title')} description={$t('frameleaf_layout_how_description')}>
    <Row
      label={$t('frameleaf_layout_sort')}
      help={sorted
        ? $t('frameleaf_layout_sort_on', { values: { path: example.parts.join(' › ') } })
        : $t('frameleaf_layout_sort_off')}
    >
      <Switch
        label={$t('frameleaf_layout_sort')}
        checked={sorted}
        held={disabled}
        onChange={(on) => draft && (draft.storageTemplate.enabled = on)}
      />
    </Row>
    {#if sorted}
      <div class="choices">
        <Tiles label={$t('frameleaf_layout_label')} value={layout} options={tiles} {disabled} onChange={choose} />
      </div>
      <div class="example" role="status">
        <p>{$t('frameleaf_layout_example')}</p>
        <p class="path">{whole.join(' › ')}</p>
      </div>
      {#if example.unknown.length > 0}
        <div class="pad">
          <Notice tone="warn" title={$t('frameleaf_layout_unknown', { values: { names: example.unknown.join(', ') } })}>
            {$t('frameleaf_layout_unknown_body')}
          </Notice>
        </div>
      {/if}
      {#if long}
        <div class="pad">
          <Notice tone="warn" title={$t('frameleaf_layout_long')}>{$t('frameleaf_layout_long_body')}</Notice>
        </div>
      {/if}
      {#if !unsaved && savedSorted && status && !refiling}
        <div class="pad">
          <Notice title={$t('frameleaf_layout_new_only')}>
            {#snippet action()}
              <Button onclick={refile}>{$t('frameleaf_layout_refile')}</Button>
            {/snippet}
            {$t('frameleaf_layout_new_only_body', { values: { count: count(status.candidates) } })}
          </Notice>
        </div>
      {/if}
    {/if}
    <Advanced summary={$t('frameleaf_layout_advanced')} open={layout === 'custom'}>
      <Row
        label={$t('frameleaf_layout_verify')}
        help={draft?.storageTemplate.hashVerificationEnabled
          ? $t('frameleaf_layout_verify_on')
          : $t('frameleaf_layout_verify_off')}
      >
        <Switch
          label={$t('frameleaf_layout_verify')}
          checked={draft?.storageTemplate.hashVerificationEnabled ?? true}
          held={disabled}
          onChange={(on) => draft && (draft.storageTemplate.hashVerificationEnabled = on)}
        />
      </Row>
      <Row label={$t('frameleaf_layout_pattern')} help={$t('frameleaf_layout_pattern_help')} />
      <input
        type="text"
        class="pattern"
        aria-label={$t('frameleaf_layout_pattern')}
        spellcheck="false"
        value={template}
        disabled={disabled || !sorted}
        oninput={(event) => draft && (draft.storageTemplate.template = event.currentTarget.value)}
      />
      <dl class="terms">
        {#each TERMS as term (term)}
          <dt>{term === 'slash' ? '/' : `{{${term}}}`}</dt>
          <dd>{$t(`frameleaf_layout_term_${term}` as Translations)}</dd>
        {/each}
      </dl>
      <p class="hint">{$t('frameleaf_layout_pattern_rules')}</p>
    </Advanced>
  </Section>
</KitPage>

<style>
  .choices,
  .pad {
    padding-bottom: var(--fl-space-4);
  }
  .example {
    display: grid;
    gap: var(--fl-space-2);
    margin-bottom: var(--fl-space-4);
    padding: var(--fl-space-4);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-control);
  }
  .example p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .example .path {
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .pattern {
    width: 100%;
    min-height: var(--fl-control-height);
    margin-bottom: var(--fl-space-3);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font-family: var(--fl-font-mono, monospace);
    font-size: var(--fl-font-callout);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .terms {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--fl-space-2) var(--fl-space-4);
    margin: 0 0 var(--fl-space-3);
    font-size: var(--fl-font-small);
  }
  .terms dt {
    font-family: var(--fl-font-mono, monospace);
  }
  .terms dd {
    margin: 0;
    color: var(--fl-muted);
  }
  .hint {
    margin: 0 0 var(--fl-space-4);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
</style>
