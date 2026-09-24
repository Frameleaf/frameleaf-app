<script lang="ts">
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import IconChooser from '$lib/components/frameleaf/IconChooser.svelte';
  import RuleBuilder from '$lib/components/frameleaf/RuleBuilder.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { defaultIconFor, type AlbumDetailsDraft } from '$lib/frameleaf/album-directory';
  import { emptyRule, ruleProblem, toCreate, type RuleDraft } from '$lib/frameleaf/classification-rules';
  import { loadRuleSources, type RuleSources } from '$lib/frameleaf/classification-sources';
  import { AlbumKind, type AlbumResponseDto, type ClassificationRuleCreateDto, type CreateAlbumDto } from '@immich/sdk';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * Create or edit an album, a collection or a shared space: the design's `CollectionFormDialog`
   * (`CollectionHeader.jsx:330-455`), which serves both "New …" and "Edit …". The icon chooser
   * over the whole Material catalogue is embedded instead of a small fixed grid; an album may be
   * placed inside a collection the user can edit.
   *
   * Editing (`album` + `onSave`) prefills the saved details and saves them through the caller;
   * a smart album's rule is edited in `SmartAlbumRuleDialog`, so the switch is not offered here.
   *
   * An album can be a smart album (FL-60): the Smart album switch and rule builder from the
   * design's `CollectionFormDialog`. A smart album is created with its rule in one request and
   * fills itself only when the rule is applied; the live count above the Create button is a
   * read-only preview.
   */
  interface Props {
    kind: AlbumKind;
    /** Collections the user can add to, offered as the album's home. */
    collections: AlbumResponseDto[];
    defaultParentId?: string | null;
    open?: boolean;
    onCreate: (dto: CreateAlbumDto) => Promise<boolean>;
    /** Open with the Smart album switch on (the New menu's "Smart album"). */
    smart?: boolean;
    /** Create a smart album with its rule. Without it the switch is not offered. */
    onCreateSmart?: (dto: ClassificationRuleCreateDto) => Promise<boolean>;
    /** The album, collection or space being edited. With it the dialog is "Edit …" and calls `onSave`. */
    album?: AlbumResponseDto;
    /**
     * Save the edited details. `parentId` is sent only when the collection field was offered
     * (`canMove`), so a member who may not move the album never changes where it lives.
     */
    onSave?: (dto: AlbumDetailsDraft) => Promise<boolean>;
    /** Offer the collection field while editing; moving an album is the owner's (server rule). */
    canMove?: boolean;
  }

  let {
    kind,
    collections,
    defaultParentId = null,
    open = $bindable(false),
    onCreate,
    smart: smartDefault = false,
    onCreateSmart,
    album,
    onSave,
    canMove = false,
  }: Props = $props();

  const editing = $derived(!!album && !!onSave);
  const formKind = $derived(album?.kind ?? kind);

  let smart = $state(false);
  let rule = $state<RuleDraft>(emptyRule());
  let sources = $state<RuleSources>({ people: [], tags: [] });
  let sourcesLoaded = false;
  const canBeSmart = $derived(!editing && kind === AlbumKind.Album && !!onCreateSmart);
  const smartOn = $derived(canBeSmart && smart);

  $effect(() => {
    if (!open || !smartOn || sourcesLoaded) {
      return;
    }
    sourcesLoaded = true;
    void loadRuleSources().then((loaded) => {
      sources = loaded;
      if (loaded.settings && rule.personIds.length + rule.tagIds.length === 0) {
        rule = { ...rule, action: loaded.settings.defaultAction };
      }
    });
  });

  let albumName = $state('');
  let description = $state('');
  let icon = $state<string>(defaultIconFor(kind));
  let parentId = $state<string | null>(defaultParentId);
  let busy = $state(false);
  let error = $state('');

  $effect(() => {
    if (!open) {
      return;
    }

    const current = untrack(() => (editing ? album : undefined));
    albumName = current?.albumName ?? '';
    description = current?.description ?? '';
    icon = current?.icon ?? defaultIconFor(current?.kind ?? kind);
    parentId = current ? (current.parentId ?? null) : kind === AlbumKind.Album ? defaultParentId : null;
    error = '';
    smart = smartDefault;
    rule = emptyRule(untrack(() => sources.settings?.defaultAction));
  });

  const title = $derived(
    editing
      ? formKind === AlbumKind.Collection
        ? $t('frameleaf_albums_edit_collection')
        : formKind === AlbumKind.Space
          ? $t('frameleaf_albums_edit_space')
          : $t('frameleaf_albums_edit_album')
      : kind === AlbumKind.Collection
        ? $t('frameleaf_albums_create_collection')
        : kind === AlbumKind.Space
          ? $t('frameleaf_albums_create_space')
          : $t('frameleaf_albums_create_album'),
  );
  /** Collections the album may live in; never itself (CollectionHeader.jsx `parentOptions`). */
  const parents = $derived(collections.filter((collection) => collection.id !== album?.id));
  const showParent = $derived(formKind === AlbumKind.Album && parents.length > 0 && (!editing || canMove));

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const name = albumName.trim();
    if (!name) {
      error = $t('frameleaf_albums_name_required');
      return;
    }
    if (smartOn) {
      const problem = ruleProblem(rule);
      if (problem) {
        error = $t(problem);
        return;
      }
    }
    busy = true;
    error = '';
    try {
      if (editing) {
        const saved = await onSave!({
          albumName: name,
          description: description.trim() || null,
          icon,
          ...(showParent && { parentId: parentId ?? null }),
        });
        if (saved) {
          open = false;
        }
        return;
      }
      const ok = smartOn
        ? await onCreateSmart!(
            toCreate(rule, {
              albumName: name,
              description: description.trim() || null,
              icon,
              parentId: parentId ?? null,
            }),
          )
        : await onCreate({
            albumName: name,
            description: description.trim() || null,
            icon,
            kind,
            parentId: kind === AlbumKind.Album && parentId ? parentId : undefined,
          });
      if (ok) {
        open = false;
      }
    } finally {
      busy = false;
    }
  };
</script>

<Dialog {title} closeLabel={$t('close')} wide={smartOn} bind:open>
  <form class="create" class:smart={smartOn} onsubmit={submit}>
    {#if kind === AlbumKind.Space && !editing}
      <p class="hint">{$t('frameleaf_albums_space_description')}</p>
    {/if}
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
    {#if showParent}
      <label class="field">
        <span>{$t('frameleaf_albums_in_collection')}</span>
        <select bind:value={parentId}>
          <option value={null}>{$t('frameleaf_albums_no_collection')}</option>
          {#each parents as collection (collection.id)}
            <option value={collection.id}>{collection.albumName || $t('unnamed_album')}</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if canBeSmart}
      <label class="switch">
        <input type="checkbox" role="switch" bind:checked={smart} aria-describedby="album-create-smart-help" />
        <span>{$t('frameleaf_albums_smart_mark')}</span>
        <small id="album-create-smart-help">{$t('frameleaf_rules_smart_help')}</small>
      </label>
      {#if smartOn}
        <RuleBuilder
          {rule}
          people={sources.people}
          tags={sources.tags}
          settings={sources.settings}
          onChange={(next) => (rule = next)}
        />
      {/if}
    {/if}
    {#if error}
      <Status message={error} />
    {/if}
    <div class="buttons">
      <button type="button" onclick={() => (open = false)} disabled={busy}>{$t('cancel')}</button>
      <button type="submit" class="primary" disabled={busy}>{editing ? $t('save') : $t('create')}</button>
    </div>
  </form>
</Dialog>

<style>
  .create {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-block-start: 1rem;
    width: min(32rem, 100%);
  }
  .create.smart {
    width: min(44rem, 100%);
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
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
  .field textarea,
  .field select {
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
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
  .preview {
    display: inline-flex;
    color: var(--fl-text);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .buttons button {
    padding: 0 1rem;
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
