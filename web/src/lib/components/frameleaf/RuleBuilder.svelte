<script lang="ts">
  import {
    DEFAULT_SAMPLE_SIZE,
    PREVIEW_DEBOUNCE_MS,
    normalizeRule,
    parsePhrases,
    previewKey,
    ruleIsEmpty,
    toPreview,
    type RuleDraft,
  } from '$lib/frameleaf/classification-rules';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import {
    ClassificationMediaType,
    ClassificationRuleAction,
    previewClassificationRule,
    type ClassificationPreviewResponseDto,
    type ClassificationSettingsDto,
    type PersonResponseDto,
    type TagResponseDto,
  } from '@immich/sdk';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The smart album rule builder (FL-60), ported from `RuleBuilder` in
   * `design/frameleaf/template/src/CollectionHeader.jsx`: people (any of), tags (any of), a date
   * range and the media type, with a live count of what matches.
   *
   * The count comes from `POST /classification/preview`, which reads and never writes. A draft with
   * visual categories is previewed over the newest items only, and says so. Below the criteria the
   * person chooses what a match does — suggest it for review or add the rule's own tag — and may
   * opt in to archiving, which needs its own explicit consent.
   */
  interface Props {
    rule: RuleDraft;
    people: PersonResponseDto[];
    tags: TagResponseDto[];
    settings?: ClassificationSettingsDto;
    onChange: (rule: RuleDraft) => void;
  }

  let { rule, people, tags, settings, onChange }: Props = $props();

  const set = (patch: Partial<RuleDraft>) => onChange(normalizeRule({ ...rule, ...patch }));
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];

  let tagFilter = $state('');
  const visibleTags = $derived(
    tagFilter.trim() ? tags.filter((tag) => tag.value.toLowerCase().includes(tagFilter.trim().toLowerCase())) : tags,
  );
  const namedPeople = $derived(people.filter((person) => person.name));

  let phrasesText = $state(rule.visualQueries.join(', '));

  /* ---- live preview: read-only, debounced, latest request wins ---- */
  let preview = $state<ClassificationPreviewResponseDto | undefined>();
  let previewFailed = $state(false);
  let loading = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requested = '';
  let controller: AbortController | undefined;

  const key = $derived(previewKey(rule));
  const empty = $derived(ruleIsEmpty(rule));

  const runPreview = async (draft: RuleDraft, draftKey: string) => {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    loading = true;
    try {
      const result = await previewClassificationRule(
        { classificationPreviewDto: toPreview(draft, DEFAULT_SAMPLE_SIZE) },
        { signal },
      );
      if (requested === draftKey) {
        preview = result;
        previewFailed = false;
      }
    } catch {
      if (!signal.aborted && requested === draftKey) {
        preview = undefined;
        previewFailed = true;
      }
    } finally {
      if (requested === draftKey) {
        loading = false;
      }
    }
  };

  $effect(() => {
    const draftKey = key;
    const draft = rule;
    if (empty) {
      clearTimeout(timer);
      controller?.abort();
      requested = '';
      preview = undefined;
      loading = false;
      return;
    }
    if (draftKey === requested) {
      return;
    }
    requested = draftKey;
    clearTimeout(timer);
    timer = setTimeout(() => void runPreview(draft, draftKey), PREVIEW_DEBOUNCE_MS);
  });

  onDestroy(() => {
    clearTimeout(timer);
    controller?.abort();
  });

  const status = $derived.by(() => {
    if (empty) {
      return $t('frameleaf_rules_preview_empty');
    }
    if (previewFailed) {
      return $t('frameleaf_rules_preview_failed');
    }
    if (!preview) {
      return $t('frameleaf_rules_preview_loading');
    }
    if (!preview.visualSearchAvailable) {
      return $t('frameleaf_rules_preview_visual_unavailable');
    }
    return preview.exact
      ? $t('frameleaf_rules_preview_exact', { values: { count: preview.matched } })
      : $t('frameleaf_rules_preview_sample', { values: { count: preview.matched, sampled: preview.sampled } });
  });

  const visualEnabled = $derived(settings?.visualCategories !== false);
</script>

<div class="rule">
  <fieldset>
    <legend>{$t('frameleaf_rules_people_any')}</legend>
    <div class="checks">
      {#each namedPeople as person (person.id)}
        {@const on = rule.personIds.includes(person.id)}
        <label class="check person" class:on>
          <input type="checkbox" checked={on} onchange={() => set({ personIds: toggle(rule.personIds, person.id) })} />
          <img class="fl-squircle" src={getPeopleThumbnailUrl(person)} alt="" width="24" height="24" />
          <span>{person.name}</span>
        </label>
      {/each}
      {#if namedPeople.length === 0}
        <span class="muted">{$t('frameleaf_rules_no_people')}</span>
      {/if}
    </div>
  </fieldset>

  <fieldset>
    <legend>{$t('frameleaf_rules_tags_any')}</legend>
    {#if tags.length > 24}
      <input
        class="filter"
        type="search"
        bind:value={tagFilter}
        placeholder={$t('frameleaf_rules_find_tag')}
        aria-label={$t('frameleaf_rules_find_tag')}
      />
    {/if}
    <div class="checks">
      {#each visibleTags as tag (tag.id)}
        {@const on = rule.tagIds.includes(tag.id)}
        <label class="check" class:on>
          <input type="checkbox" checked={on} onchange={() => set({ tagIds: toggle(rule.tagIds, tag.id) })} />
          {tag.value}
        </label>
      {/each}
      {#if tags.length === 0}
        <span class="muted">{$t('frameleaf_rules_no_tags')}</span>
      {/if}
    </div>
  </fieldset>

  <div class="row">
    <label class="field">
      <span>{$t('frameleaf_rules_from')}</span>
      <input
        type="date"
        value={rule.takenAfter ?? ''}
        max={rule.takenBefore ?? undefined}
        onchange={(event) => set({ takenAfter: event.currentTarget.value || null })}
      />
    </label>
    <label class="field">
      <span>{$t('frameleaf_rules_to')}</span>
      <input
        type="date"
        value={rule.takenBefore ?? ''}
        min={rule.takenAfter ?? undefined}
        onchange={(event) => set({ takenBefore: event.currentTarget.value || null })}
      />
    </label>
    <label class="field">
      <span>{$t('frameleaf_rules_media')}</span>
      <select
        value={rule.mediaType}
        onchange={(event) => set({ mediaType: event.currentTarget.value as ClassificationMediaType })}
      >
        <option value={ClassificationMediaType.Any}>{$t('frameleaf_rules_photos_and_videos')}</option>
        <option value={ClassificationMediaType.Photo}>{$t('frameleaf_rules_photos_only')}</option>
        <option value={ClassificationMediaType.Video}>{$t('frameleaf_rules_videos_only')}</option>
      </select>
    </label>
  </div>

  {#if visualEnabled}
    <div class="row visual">
      <label class="field wide">
        <span>{$t('frameleaf_rules_visual')}</span>
        <input
          type="text"
          bind:value={phrasesText}
          placeholder={$t('frameleaf_rules_visual_placeholder')}
          onchange={() => set({ visualQueries: parsePhrases(phrasesText) })}
        />
      </label>
      <label class="field">
        <span>{$t('frameleaf_rules_confidence', { values: { value: Math.round(rule.threshold * 100) } })}</span>
        <input
          type="range"
          min="0.1"
          max="0.5"
          step="0.01"
          value={rule.threshold}
          disabled={rule.visualQueries.length === 0}
          onchange={(event) => set({ threshold: Number(event.currentTarget.value) })}
        />
      </label>
    </div>
  {/if}

  <div class="row actions">
    <label class="field">
      <span>{$t('frameleaf_rules_action')}</span>
      <select
        value={rule.action}
        onchange={(event) => set({ action: event.currentTarget.value as ClassificationRuleAction })}
      >
        <option value={ClassificationRuleAction.Review}>{$t('frameleaf_rules_action_review')}</option>
        <option value={ClassificationRuleAction.Tag}>{$t('frameleaf_rules_action_tag')}</option>
      </select>
    </label>
    {#if rule.action === ClassificationRuleAction.Tag}
      <label class="field wide">
        <span>{$t('frameleaf_rules_tag_name')}</span>
        <input
          type="text"
          maxlength="120"
          value={rule.tagName}
          onchange={(event) => set({ tagName: event.currentTarget.value })}
        />
      </label>
    {/if}
  </div>

  <label class="switch">
    <input
      type="checkbox"
      role="switch"
      checked={rule.archive}
      onchange={(event) => set({ archive: event.currentTarget.checked, archiveConsent: false })}
    />
    <span>{$t('frameleaf_rules_archive')}</span>
    <small>{$t('frameleaf_rules_archive_help')}</small>
  </label>
  {#if rule.archive}
    <label class="consent">
      <input
        type="checkbox"
        checked={rule.archiveConsent}
        onchange={(event) => set({ archiveConsent: event.currentTarget.checked })}
      />
      <span>{$t('frameleaf_rules_archive_consent')}</span>
    </label>
  {/if}

  <p class="preview" role="status" aria-live="polite" aria-busy={loading}>{status}</p>
</div>

<style>
  .rule {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend,
  .field > span {
    margin-bottom: 0.25rem;
    font-size: var(--fl-font-small);
    font-weight: 600;
    color: var(--fl-muted);
  }
  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .check {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 4px 10px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-panel);
    font-size: var(--fl-font-small);
    cursor: pointer;
  }
  .check.person {
    padding-left: 6px;
  }
  .check img {
    width: 24px;
    height: 24px;
    object-fit: cover;
  }
  .check input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .check.on {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
  }
  .check:has(input:focus-visible) {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  .row.visual,
  .row.actions {
    grid-template-columns: 2fr 1fr;
  }
  .row.actions {
    grid-template-columns: 1fr 2fr;
  }
  .field {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .field input:not([type='range']),
  .field select,
  .filter {
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
  }
  .field input[type='range'] {
    accent-color: var(--fl-accent);
  }
  .preview,
  .muted,
  .switch small {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .switch,
  .consent {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 10px;
    align-items: center;
    cursor: pointer;
  }
  .switch small {
    grid-column: 2;
  }
  .switch input,
  .consent input {
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--fl-accent);
  }
  .consent {
    padding: 8px 10px;
    border: 1px solid var(--fl-warning);
    border-radius: var(--fl-radius-control);
    font-size: var(--fl-font-small);
  }
  @media (max-width: 640px) {
    .row,
    .row.visual,
    .row.actions {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
