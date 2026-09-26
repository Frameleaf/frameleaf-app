<script lang="ts">
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import IconChooser from '$lib/components/frameleaf/IconChooser.svelte';
  import RuleBuilder from '$lib/components/frameleaf/RuleBuilder.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { defaultIconFor } from '$lib/frameleaf/album-directory';
  import { fromResponse, ruleProblem, toUpdate, type RuleDraft } from '$lib/frameleaf/classification-rules';
  import type { RuleSources } from '$lib/frameleaf/classification-sources';
  import { handleUpdateAlbumInfo } from '$lib/services/album.service';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AlbumKind,
    deleteClassificationRule,
    updateClassificationRule,
    type AlbumResponseDto,
    type ClassificationRuleResponseDto,
  } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  /**
   * Edit a smart album (FL-60), ported from `CollectionFormDialog` in `CollectionHeader.jsx` as the
   * design opens it from "Edit details": name, description, icon, the Smart album switch and the rule
   * builder. Saving the rule changes nothing in the library; Re-evaluate applies it. Pausing the rule
   * keeps everything it applied. Turning Smart album off removes the rule and leaves an ordinary album
   * with everything still in it.
   */
  interface Props {
    album: AlbumResponseDto;
    rule: ClassificationRuleResponseDto;
    sources: RuleSources;
    open?: boolean;
    onSaved: (rule: ClassificationRuleResponseDto | null, message: string, album?: AlbumResponseDto) => void;
  }

  let { album, rule, sources, open = $bindable(false), onSaved }: Props = $props();

  let albumName = $state('');
  let description = $state('');
  let icon = $state('');
  let draft = $state<RuleDraft>(fromResponse(rule));
  let smart = $state(true);
  let busy = $state(false);
  let error = $state('');

  $effect(() => {
    if (!open) {
      return;
    }
    albumName = album.albumName;
    description = album.description ?? '';
    icon = album.icon ?? defaultIconFor(AlbumKind.Album);
    draft = fromResponse(rule);
    smart = true;
    error = '';
  });

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const name = albumName.trim();
    if (!name) {
      error = $t('frameleaf_albums_name_required');
      return;
    }
    const problem = smart ? ruleProblem(draft) : null;
    if (problem) {
      error = $t(problem);
      return;
    }
    busy = true;
    error = '';
    try {
      let updatedAlbum: AlbumResponseDto | undefined;
      const details = {
        ...(name !== album.albumName && { albumName: name }),
        ...(description.trim() !== (album.description ?? '') && { description: description.trim() }),
        ...(icon !== (album.icon ?? defaultIconFor(AlbumKind.Album)) && { icon }),
      };
      if (Object.keys(details).length > 0) {
        updatedAlbum = await handleUpdateAlbumInfo(album.id, details);
        if (!updatedAlbum) {
          return;
        }
      }
      if (!smart) {
        await deleteClassificationRule({ id: rule.id });
        onSaved(null, $t('frameleaf_rules_removed'), updatedAlbum);
        open = false;
        return;
      }
      const updated = await updateClassificationRule({
        id: rule.id,
        classificationRuleUpdateDto: toUpdate(draft, rule),
      });
      onSaved(updated, $t('frameleaf_rules_saved'), updatedAlbum);
      open = false;
    } catch (error_) {
      handleError(error_, $t('frameleaf_rules_save_failed'));
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('edit_album')} closeLabel={$t('close')} wide bind:open>
  <form class="form" onsubmit={save}>
    <label class="field">
      <span>{$t('name')}</span>
      <input type="text" bind:value={albumName} required maxlength="120" autocomplete="off" />
    </label>
    <label class="field">
      <span>{$t('description')}</span>
      <textarea bind:value={description} rows="2" maxlength="2000"></textarea>
    </label>
    <div class="field">
      <span class="field-label">
        {$t('icon')}
        <span class="preview" aria-hidden="true"><AlbumIcon name={icon} size="20" /></span>
      </span>
      <IconChooser value={icon} onChange={(name) => (icon = name)} inline label={$t('frameleaf_icons_choose')} />
    </div>
    <label class="switch">
      <input type="checkbox" role="switch" bind:checked={smart} />
      <span>{$t('frameleaf_albums_smart_mark')}</span>
      <small>{smart ? $t('frameleaf_rules_smart_help') : $t('frameleaf_rules_smart_off_help')}</small>
    </label>
    {#if smart}
      <label class="switch">
        <input
          type="checkbox"
          role="switch"
          checked={draft.enabled}
          onchange={(event) => (draft = { ...draft, enabled: event.currentTarget.checked })}
        />
        <span>{$t('frameleaf_rules_enabled')}</span>
        <small>{$t('frameleaf_rules_enabled_help')}</small>
      </label>
      <RuleBuilder
        rule={draft}
        people={sources.people}
        tags={sources.tags}
        settings={sources.settings}
        onChange={(next) => (draft = next)}
      />
    {/if}
    {#if error}
      <Status message={error} />
    {/if}
    <div class="buttons">
      <button type="button" onclick={() => (open = false)} disabled={busy}>{$t('cancel')}</button>
      <button type="submit" class="primary" disabled={busy}>{$t('save')}</button>
    </div>
  </form>
</Dialog>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-block-start: 1rem;
    width: min(44rem, 100%);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .field > span,
  .field-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--fl-muted);
  }
  .field input,
  .field textarea {
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
  }
  .preview {
    display: inline-flex;
    color: var(--fl-text);
  }
  .switch {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 10px;
    align-items: center;
    cursor: pointer;
  }
  .switch small {
    grid-column: 2;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .switch input {
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--fl-accent);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .buttons button {
    padding: 0.375rem 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .buttons .primary {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .buttons button:disabled {
    opacity: 0.6;
  }
</style>
