<script lang="ts">
  /**
   * Libraries › Add a folder of photos as a page (FL-539, after the prototype's `FolderForm` in
   * `settings-v2/library/folders.jsx`), in place of the dialog: four numbered steps.
   *
   * 1. Choose the folder: browse what this server can see (`browseLibraryFolders`, names only), and
   *    once one is chosen, "About N photos and videos, X GB" (`estimateLibraryFolder`, with the
   *    folder's skips). Typing a path is under Advanced.
   * 2. Whose library, and the name.
   * 3. What to skip: the two recommended choices (the server's own defaults), patterns under Advanced.
   * 4. The first check: starts by itself when the folder is added (`scanLibrary`), unless switched off;
   *    after that the folder is checked in the overnight schedule.
   *
   * Create checks every folder again on the server, so the page's checks are a convenience.
   */
  import '$lib/frameleaf/libraries.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import TextArea from '$lib/components/frameleaf/settings/kit/TextArea.svelte';
  import { formatBytes } from '$lib/frameleaf/format-bytes';
  import { DEFAULT_EXCLUSION_PATTERNS, LIBRARY_NAME_MAX_LENGTH, isImportPathFormatValid } from '$lib/frameleaf/libraries';
  import { locale } from '$lib/stores/preferences.store';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    browseLibraryFolders,
    createLibrary,
    estimateLibraryFolder,
    scanLibrary,
    type LibraryFolderBrowseResponseDto,
    type LibraryFolderEstimateResponseDto,
    type LibraryResponseDto,
    type UserAdminResponseDto,
  } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  type Props = {
    owners: UserAdminResponseDto[];
    ownerId?: string;
    onAdded: (library: LibraryResponseDto, scanning: boolean) => void;
    onCancel: () => void;
    onOpenChecks: () => void;
  };
  let { owners, ownerId, onAdded, onCancel, onOpenChecks }: Props = $props();

  /** Hidden and system files: macOS's own files (as on the edit form). */
  const HIDDEN_PATTERNS = ['**/.DS_Store', '**/._*'];

  let folder = $state('');
  let typed = $state('');
  let owner = $state(ownerId ?? owners[0]?.id ?? '');
  let name = $state('');
  let nasPatterns = $state<string[]>(
    DEFAULT_EXCLUSION_PATTERNS.filter((pattern) => !HIDDEN_PATTERNS.includes(pattern)),
  );
  let skipHidden = $state(true);
  let skipNas = $state(true);
  let extra = $state('');
  let first = $state(true);
  let readOnly = $state(true);
  let saving = $state(false);
  let error = $state('');

  const patterns = $derived([
    ...(skipHidden ? HIDDEN_PATTERNS : []),
    ...(skipNas ? nasPatterns : []),
    ...extra
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  ]);
  const ownerName = $derived(owners.find((user) => user.id === owner)?.name ?? '');

  // ---- 1. Choose the folder ----
  let browsing = $state<LibraryFolderBrowseResponseDto | null>(null);
  let browseOpen = $state(false);
  let browseError = $state('');
  const browse = async (path?: string) => {
    browseError = '';
    try {
      browsing = await browseLibraryFolders({ path });
      nasPatterns = browsing.defaultExclusionPatterns.filter((pattern) => !HIDDEN_PATTERNS.includes(pattern));
    } catch (error_) {
      browseError = getServerErrorMessage(error_) ?? $t('frameleaf_libraries_browse_failed');
    }
  };
  const choose = (path: string) => {
    folder = path;
    if (!name.trim()) {
      name = path.split('/').filter(Boolean).at(-1) ?? '';
    }
    browseOpen = false;
  };

  /** "About N photos and videos, X GB", read again when the folder or what it skips changes. */
  let estimate = $state<LibraryFolderEstimateResponseDto | null>(null);
  let estimating = $state(false);
  $effect(() => {
    const path = folder;
    const skips = patterns;
    estimate = null;
    if (!path) {
      return;
    }
    let active = true;
    estimating = true;
    void estimateLibraryFolder({ path, exclusionPatterns: skips })
      .then((answer) => {
        if (active) {
          estimate = answer;
        }
      })
      .catch(() => {
        if (active) {
          estimate = null;
        }
      })
      .finally(() => {
        if (active) {
          estimating = false;
        }
      });
    return () => {
      active = false;
    };
  });
  const count = (value: number) => value.toLocaleString($locale);
  const folderHelp = $derived.by(() => {
    if (!folder) {
      return $t('frameleaf_addfolder_choose_help');
    }
    if (estimating || !estimate) {
      return $t('frameleaf_addfolder_counting');
    }
    if (!estimate.readable) {
      return $t('frameleaf_addfolder_unreadable');
    }
    return $t(estimate.complete ? 'frameleaf_addfolder_found' : 'frameleaf_addfolder_found_more', {
      values: { count: count(estimate.count), size: formatBytes(estimate.bytes) },
    });
  });
  const ready = $derived(
    !!folder &&
      isImportPathFormatValid(folder) &&
      !!owner &&
      name.trim().length > 0 &&
      !(estimate && (!estimate.readable || estimate.count === 0)),
  );

  const add = async () => {
    error = '';
    saving = true;
    try {
      const library = await createLibrary({
        createLibraryDto: {
          ownerId: owner,
          readOnly,
          name: name.trim(),
          importPaths: [folder],
          exclusionPatterns: patterns,
        },
      });
      let scanning = false;
      if (first) {
        try {
          await scanLibrary({ id: library.id });
          scanning = true;
        } catch {
          // the folder is added; its first check waits for the next night or Check now
        }
      }
      onAdded(library, scanning);
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_libraries_error_save');
    } finally {
      saving = false;
    }
  };
</script>

<KitPage>
  {#if error}
    <Notice tone="warn" title={$t('frameleaf_libraries_error_save')}>{error}</Notice>
  {/if}

  <Section title={$t('frameleaf_addfolder_step1')}>
    <Row label={$t('frameleaf_addfolder_folder')} help={folderHelp}>
      <span class="inline">
        {#if folder}<code class="path">{folder}</code>{/if}
        <Button
          variant={folder ? 'default' : 'primary'}
          onclick={() => {
            browseOpen = !browseOpen;
            if (browseOpen && !browsing) {
              void browse(folder || undefined);
            }
          }}
        >
          {folder ? $t('frameleaf_addfolder_change') : $t('frameleaf_libraries_choose_folder')}
        </Button>
      </span>
    </Row>
    {#if browseOpen}
      <div class="fl-libraries">
        <div class="resource-browser" role="group" aria-label={$t('frameleaf_libraries_choose_folder')}>
          {#if browseError}
            <p class="resource-error" role="alert">{browseError}</p>
          {:else if browsing}
            <p class="resource-footnote">
              <code>{browsing.path}</code>
              {#if !browsing.readable}· {$t('frameleaf_libraries_browse_unreadable')}{/if}
            </p>
            <ul>
              {#if browsing.parent}
                <li>
                  <button type="button" class="resource-button" onclick={() => browse(browsing!.parent!)}
                    >{$t('frameleaf_libraries_browse_up')}</button
                  >
                </li>
              {/if}
              {#each browsing.folders as entry (entry.path)}
                <li>
                  <button type="button" class="resource-button" onclick={() => browse(entry.path)}>{entry.name}</button>
                </li>
              {:else}
                <li class="resource-footnote">{$t('frameleaf_libraries_browse_empty')}</li>
              {/each}
            </ul>
            {#if browsing.path !== '/' && browsing.readable}
              <button type="button" class="resource-button primary" onclick={() => choose(browsing!.path)}
                >{$t('frameleaf_libraries_browse_use')}</button
              >
            {/if}
          {/if}
        </div>
      </div>
    {/if}
    {#if folder && estimate && estimate.readable && estimate.count === 0}
      <Notice tone="warn" title={$t('frameleaf_addfolder_empty_title')}>{$t('frameleaf_addfolder_empty_body')}</Notice>
    {:else if folder && estimate && !estimate.readable}
      <Notice tone="warn" title={$t('frameleaf_addfolder_blocked_title')}>{$t('frameleaf_addfolder_blocked_body')}</Notice>
    {/if}
    <Advanced summary={$t('frameleaf_addfolder_type_path')}>
      <Row label={$t('frameleaf_addfolder_path')} help={$t('frameleaf_addfolder_path_help')}>
        <Field
          wide
          label={$t('frameleaf_addfolder_path')}
          value={typed}
          placeholder="/mnt/photos/family"
          onChange={(value) => {
            typed = value;
            if (isImportPathFormatValid(value.trim())) {
              choose(value.trim());
            }
          }}
        />
      </Row>
    </Advanced>
  </Section>

  <Section title={$t('frameleaf_addfolder_step2')}>
    <Row
      label={$t('frameleaf_addfolder_whose')}
      help={ownerName ? $t('frameleaf_addfolder_whose_help', { values: { name: ownerName } }) : undefined}
    >
      <select class="select" aria-label={$t('frameleaf_addfolder_whose')} bind:value={owner}>
        {#each owners as user (user.id)}
          <option value={user.id}>{$t('frameleaf_addfolder_library_of', { values: { name: user.name } })}</option>
        {/each}
      </select>
    </Row>
    <Row label={$t('frameleaf_libraries_field_name')} help={$t('frameleaf_addfolder_name_help')}>
      <Field
        label={$t('frameleaf_libraries_field_name')}
        value={name}
        placeholder={$t('frameleaf_addfolder_name_placeholder')}
        onChange={(value) => (name = value.slice(0, LIBRARY_NAME_MAX_LENGTH))}
      />
    </Row>
  </Section>

  <Section title={$t('frameleaf_addfolder_step3')} description={$t('frameleaf_addfolder_skip_description')}>
    <Row label={$t('frameleaf_libraries_skip_hidden')} help={$t('frameleaf_addfolder_skip_hidden_help')}>
      <Switch label={$t('frameleaf_libraries_skip_hidden')} checked={skipHidden} onChange={(value) => (skipHidden = value)} />
    </Row>
    <Row label={$t('frameleaf_libraries_skip_nas')} help={$t('frameleaf_addfolder_skip_nas_help')}>
      <Switch label={$t('frameleaf_libraries_skip_nas')} checked={skipNas} onChange={(value) => (skipNas = value)} />
    </Row>
    <Advanced summary={$t('frameleaf_libraries_skip_advanced')}>
      <p class="hint">{$t('frameleaf_addfolder_patterns_hint')}</p>
      <TextArea
        label={$t('frameleaf_addfolder_patterns')}
        value={extra}
        rows={2}
        placeholder="**/cache/**"
        onChange={(value) => (extra = value)}
      />
      <Row label={$t('frameleaf_libraries_readonly_label')} help={$t('frameleaf_libraries_readonly_hint')}>
        <Switch label={$t('frameleaf_libraries_readonly_label')} checked={readOnly} onChange={(value) => (readOnly = value)} />
      </Row>
    </Advanced>
  </Section>

  <Section title={$t('frameleaf_addfolder_step4')}>
    <Row
      label={$t('frameleaf_addfolder_first')}
      help={first ? $t('frameleaf_addfolder_first_on') : $t('frameleaf_addfolder_first_off')}
    >
      <Switch label={$t('frameleaf_addfolder_first')} checked={first} onChange={(value) => (first = value)} />
    </Row>
    <Row label={$t('frameleaf_addfolder_nightly')} help={$t('frameleaf_addfolder_nightly_help')}>
      <Button onclick={onOpenChecks}>{$t('frameleaf_addfolder_checks')}</Button>
    </Row>
    {#if ready && estimate}
      <div class="example" role="status">
        <p>
          {$t('frameleaf_addfolder_summary', {
            values: { count: count(estimate.count), name: ownerName },
          })}
        </p>
        <code class="path">{folder}</code>
        <p>{$t('frameleaf_addfolder_summary_note')}</p>
      </div>
    {/if}
    <div class="actions">
      <Button variant="primary" disabled={!ready || saving} onclick={add}>{$t('frameleaf_addfolder_add')}</Button>
      <Button disabled={saving} onclick={onCancel}>{$t('cancel')}</Button>
    </div>
  </Section>
</KitPage>

<style>
  .inline {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
  }
  .path {
    padding: 2px var(--fl-space-2);
    font-size: var(--fl-font-small);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-control);
    word-break: break-all;
  }
  .select {
    min-height: 2.25rem;
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .hint {
    margin: 0 0 var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .example {
    display: grid;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-3);
    padding: var(--fl-space-3);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .example p {
    margin: 0;
    font-size: var(--fl-font-callout);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-4);
  }
</style>
