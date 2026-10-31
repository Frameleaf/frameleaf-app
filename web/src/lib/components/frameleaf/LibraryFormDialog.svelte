<script lang="ts">
  /**
   * Add or edit an external library (FL-78), the design template's `LibraryForm` in
   * `design/frameleaf/template/src/AccountsLibraries.jsx`: a name, an owner that is fixed once the
   * library exists, import folders and exclusion patterns, a folder check and the note that saving
   * does not start a scan.
   *
   * "Check path format" asks the server, which checks the form, the location, clashes with other
   * libraries and whether it can read each folder now. Create and update check again, so the
   * check is a convenience and the endpoint is the boundary. Editing folders while a scan runs
   * says that saving stops that scan, which is what the server does.
   *
   * FL-365: "Choose folder…" browses what the server can see (`browseLibraryFolders`, names only),
   * and "What to skip" is two recommended tick boxes: hidden and system files, and NAS clutter
   * (recycle bins, snapshots, thumbnail folders). The NAS list is the server's own default, read
   * from the server, so a folder added here skips what a folder added any other way skips. The
   * patterns themselves stay under Advanced, where more can be typed.
   */
  import '$lib/frameleaf/libraries.css';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    DEFAULT_EXCLUSION_PATTERNS,
    LIBRARY_NAME_MAX_LENGTH,
    LIBRARY_PATH_MAX_LENGTH,
    LIBRARY_PATHS_MAX,
    checkPathList,
    foldersChanged,
    isImportPathFormatValid,
    isScanActive,
  } from '$lib/frameleaf/libraries';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    browseLibraryFolders,
    createLibrary,
    updateLibrary,
    type LibraryFolderBrowseResponseDto,
    validate,
    type LibraryResponseDto,
    type UserAdminResponseDto,
    type ValidateLibraryImportPathResponseDto,
  } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  type Props = {
    /** The library being edited; absent to add one. */
    library?: LibraryResponseDto;
    /** Accounts that may own a new library: active ones. */
    owners: UserAdminResponseDto[];
    /** The owner preselected for a new library. */
    ownerId?: string;
    onSaved: (library: LibraryResponseDto) => void;
    onClose: () => void;
  };

  let { library, owners, ownerId, onSaved, onClose }: Props = $props();

  let open = $state(true);
  let name = $state(library?.name ?? '');
  let readOnly = $state(library ? (library.readOnly ?? false) : true);
  let owner = $state(library?.ownerId ?? ownerId ?? owners[0]?.id ?? '');
  let importPaths = $state<string[]>([...(library?.importPaths ?? [])]);
  let exclusionPatterns = $state<string[]>([...(library?.exclusionPatterns ?? DEFAULT_EXCLUSION_PATTERNS)]);
  let validation = $state<ValidateLibraryImportPathResponseDto[] | null>(null);
  let error = $state('');
  let saving = $state(false);
  let checking = $state(false);

  const idPrefix = $props.id();
  const editing = $derived(!!library);
  const stopsScan = $derived(
    !!library && isScanActive(library.scan) && foldersChanged(library, { importPaths, exclusionPatterns }),
  );

  $effect(() => {
    if (!open) {
      onClose();
    }
  });

  const setPaths = (next: string[]) => {
    importPaths = next;
    validation = null;
  };

  const setExclusions = (next: string[]) => {
    exclusionPatterns = next;
    validation = null;
  };

  // ---- FL-365: the folder chooser and "What to skip" ----
  /** Hidden and system files: macOS's own files. */
  const HIDDEN_PATTERNS = ['**/.DS_Store', '**/._*'];
  /** NAS clutter: the server's own default list once read; until then the same list the app ships. */
  let nasPatterns = $state<string[]>(
    DEFAULT_EXCLUSION_PATTERNS.filter((pattern) => !HIDDEN_PATTERNS.includes(pattern)),
  );
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
  const useFolder = (path: string) => {
    if (!importPaths.includes(path)) {
      setPaths([...importPaths.filter((item) => item.trim() !== ''), path]);
    }
    browseOpen = false;
  };
  const skips = (patterns: string[]) => patterns.every((pattern) => exclusionPatterns.includes(pattern));
  const setSkip = (patterns: string[], on: boolean) =>
    setExclusions(
      on
        ? [...exclusionPatterns, ...patterns.filter((pattern) => !exclusionPatterns.includes(pattern))]
        : exclusionPatterns.filter((pattern) => !patterns.includes(pattern)),
    );

  const check = async () => {
    error = '';
    checking = true;
    try {
      // the id only names the library whose own folders are not a clash; a new library has none
      const result = await validate({
        id: library?.id ?? '00000000-0000-4000-8000-000000000000',
        validateLibraryDto: { importPaths: importPaths.map((path) => path.trim()) },
      });
      validation = result.importPaths ?? [];
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_libraries_error_validate');
    } finally {
      checking = false;
    }
  };

  const listError = (values: string[]) => {
    switch (checkPathList(values)) {
      case 'empty': {
        return $t('frameleaf_libraries_error_list_empty');
      }
      case 'duplicate': {
        return $t('frameleaf_libraries_error_list_duplicate');
      }
      case 'too-many': {
        return $t('frameleaf_libraries_error_list_too_many');
      }
      default: {
        return '';
      }
    }
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const paths = importPaths.map((path) => path.trim());
    const exclusions = exclusionPatterns.map((pattern) => pattern.trim());
    const problem = listError(paths) || listError(exclusions);
    if (problem) {
      error = problem;
      return;
    }
    if (paths.some((path) => !isImportPathFormatValid(path))) {
      error = $t('frameleaf_libraries_error_path_format');
      return;
    }

    error = '';
    saving = true;
    try {
      const saved = library
        ? await updateLibrary({
            id: library.id,
            updateLibraryDto: { name: name.trim(), importPaths: paths, exclusionPatterns: exclusions },
          })
        : await createLibrary({
            createLibraryDto: {
              ownerId: owner,
              readOnly,
              name: name.trim(),
              importPaths: paths,
              exclusionPatterns: exclusions,
            },
          });
      onSaved(saved);
      open = false;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_libraries_error_save');
    } finally {
      saving = false;
    }
  };
</script>

{#snippet pathList(
  label: string,
  addLabel: string,
  values: string[],
  onChange: (next: string[]) => void,
  placeholder: string,
)}
  <fieldset class="resource-path-list">
    <legend>{label}</legend>
    {#each values as value, index (index)}
      <div>
        <input
          aria-label={$t('frameleaf_libraries_path_item', { values: { label, index: index + 1 } })}
          {value}
          maxlength={LIBRARY_PATH_MAX_LENGTH}
          required
          {placeholder}
          oninput={(event) => {
            const next = event.currentTarget.value;
            onChange(values.map((item, i) => (i === index ? next : item)));
          }}
        />
        <button
          type="button"
          class="resource-button"
          aria-label={$t('frameleaf_libraries_path_remove_label', {
            values: { label: label.toLowerCase(), index: index + 1 },
          })}
          onclick={() => onChange(values.filter((_, i) => i !== index))}
        >
          {$t('frameleaf_libraries_path_remove')}
        </button>
      </div>
    {/each}
    <button
      type="button"
      class="resource-button"
      disabled={values.length >= LIBRARY_PATHS_MAX}
      onclick={() => onChange([...values, ''])}
    >
      {addLabel}
    </button>
  </fieldset>
{/snippet}

<div class="fl-libraries">
  <Dialog
    bind:open
    title={editing ? $t('frameleaf_libraries_form_edit_title') : $t('frameleaf_libraries_form_create_title')}
    closeLabel={$t('frameleaf_libraries_close_dialog')}
  >
    {#if error}
      <p class="resource-error" role="alert">{error}</p>
    {/if}
    <form onsubmit={submit}>
      <div class="resource-form-grid">
        <label class="resource-field" for="{idPrefix}-name">
          <span>{$t('frameleaf_libraries_field_name')}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input id="{idPrefix}-name" required autofocus maxlength={LIBRARY_NAME_MAX_LENGTH} bind:value={name} />
        </label>
        <div class="resource-field">
          <label for="{idPrefix}-owner">{$t('frameleaf_libraries_field_owner')}</label>
          <select id="{idPrefix}-owner" disabled={editing} aria-describedby="{idPrefix}-owner-hint" bind:value={owner}>
            {#each owners as user (user.id)}
              <option value={user.id}>{user.name}</option>
            {/each}
            {#if library && owners.every((user) => user.id !== library.ownerId)}
              <option value={library.ownerId}>{library.ownerId}</option>
            {/if}
          </select>
          <small id="{idPrefix}-owner-hint">{$t('frameleaf_libraries_owner_hint')}</small>
        </div>
      </div>
      <p class="resource-notice">{$t('frameleaf_libraries_form_notice')}</p>
      <label class="resource-check">
        <input type="checkbox" bind:checked={readOnly} disabled={editing} aria-describedby="{idPrefix}-readonly-hint" />
        <span>{$t('frameleaf_libraries_readonly_label')}</span>
      </label>
      <p id="{idPrefix}-readonly-hint" class="resource-footnote">{$t('frameleaf_libraries_readonly_hint')}</p>

      {@render pathList(
        $t('frameleaf_libraries_paths_import'),
        $t('frameleaf_libraries_add_folder'),
        importPaths,
        setPaths,
        '/mnt/photos/family',
      )}
      <div class="resource-browse">
        <button
          type="button"
          class="resource-button"
          aria-expanded={browseOpen}
          onclick={() => {
            browseOpen = !browseOpen;
            if (browseOpen && !browsing) {
              void browse();
            }
          }}
        >
          {$t('frameleaf_libraries_choose_folder')}
        </button>
        {#if browseOpen}
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
                {#each browsing.folders as folder (folder.path)}
                  <li>
                    <button type="button" class="resource-button" onclick={() => browse(folder.path)}
                      >{folder.name}</button
                    >
                  </li>
                {:else}
                  <li class="resource-footnote">{$t('frameleaf_libraries_browse_empty')}</li>
                {/each}
              </ul>
              {#if browsing.truncated}
                <p class="resource-footnote">{$t('frameleaf_libraries_browse_truncated')}</p>
              {/if}
              {#if browsing.path !== '/' && browsing.readable}
                <button type="button" class="resource-button primary" onclick={() => useFolder(browsing!.path)}
                  >{$t('frameleaf_libraries_browse_use')}</button
                >
              {/if}
            {/if}
          </div>
        {/if}
      </div>

      <fieldset class="resource-path-list">
        <legend>{$t('frameleaf_libraries_skip_title')}</legend>
        <label class="resource-check">
          <input
            type="checkbox"
            checked={skips(HIDDEN_PATTERNS)}
            onchange={(event) => setSkip(HIDDEN_PATTERNS, event.currentTarget.checked)}
          />
          <span>{$t('frameleaf_libraries_skip_hidden')}</span>
        </label>
        <label class="resource-check">
          <input
            type="checkbox"
            checked={skips(nasPatterns)}
            onchange={(event) => setSkip(nasPatterns, event.currentTarget.checked)}
          />
          <span>{$t('frameleaf_libraries_skip_nas')}</span>
        </label>
      </fieldset>

      <details class="resource-advanced">
        <summary>{$t('frameleaf_libraries_skip_advanced')}</summary>
        {@render pathList(
          $t('frameleaf_libraries_paths_exclusions'),
          $t('frameleaf_libraries_add_exclusion'),
          exclusionPatterns,
          setExclusions,
          '**/cache/**',
        )}
      </details>

      <button type="button" class="resource-button" disabled={importPaths.length === 0 || checking} onclick={check}>
        {$t('frameleaf_libraries_check_paths')}
      </button>
      {#if validation}
        <div role="status" class="resource-validation">
          {#each validation as row, index (index)}
            <p>
              <code>{row.importPath || $t('frameleaf_libraries_empty_path')}</code> ·
              {$t(`frameleaf_libraries_reason_${row.reason}`)}
            </p>
          {/each}
          <small>{$t('frameleaf_libraries_validation_footnote')}</small>
        </div>
      {/if}

      {#if stopsScan}
        <p class="resource-notice" role="status">{$t('frameleaf_libraries_paths_while_scanning')}</p>
      {/if}
      <p class="resource-footnote">{$t('frameleaf_libraries_save_footnote')}</p>
      <footer>
        <button type="button" class="resource-button" onclick={() => (open = false)}>
          {$t('frameleaf_libraries_cancel')}
        </button>
        <button type="submit" class="resource-button primary" disabled={saving}>
          {editing ? $t('frameleaf_libraries_save') : $t('frameleaf_libraries_create')}
        </button>
      </footer>
    </form>
  </Dialog>
</div>
