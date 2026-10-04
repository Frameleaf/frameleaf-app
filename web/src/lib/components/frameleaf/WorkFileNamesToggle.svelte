<script lang="ts">
  /**
   * Work's file-name toggle (FL-33), ported from the template's results toolbar (`App.jsx`, the
   * `mdiFormatText` button shown in Work's grid view). Work hides file names by default; this turns
   * them back on, remembered per device. Phones hide the control, as `apple-style.css` does.
   *
   * The library toolbar belongs to the shell; this is the self-contained control it mounts.
   */
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import { Icon } from '@immich/ui';
  import { mdiFormatText } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = { preferences?: typeof libraryGridPreferences };
  let { preferences = libraryGridPreferences }: Props = $props();

  const label = $derived(
    $t(preferences.showFileNames ? 'frameleaf_library_hide_file_names' : 'frameleaf_library_show_file_names'),
  );
</script>

<span class="fl-file-names-toggle" title={label}>
  <IconButton {label} pressed={preferences.showFileNames} onclick={() => preferences.toggleFileNames()}>
    <Icon icon={mdiFormatText} size="18" aria-hidden />
  </IconButton>
</span>

<style>
  .fl-file-names-toggle {
    display: inline-flex;
  }
  @media (max-width: 700px) {
    .fl-file-names-toggle {
      display: none;
    }
  }
</style>
