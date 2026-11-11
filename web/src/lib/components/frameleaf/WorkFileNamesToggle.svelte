<script lang="ts">
  /**
   * Work's file-name toggle (FL-33), ported from the template's results toolbar (`App.jsx`, the
   * `mdiFormatText` button shown in Work's grid view). Work hides file names by default; this turns
   * them back on, remembered per device. Phones hide the control, as `apple-style.css` does.
   *
   * The item view mounts it (Boards, and a photo album shown through it). The photo library has no
   * such button since FL-1398: its View menu holds "File name", kept per layout with the account
   * (`library-view.svelte.ts`).
   */
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import { libraryView } from '$lib/frameleaf/library-view.svelte';
  import { Icon } from '@frameleaf/ui';
  import { mdiFormatText } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = { preferences?: typeof libraryGridPreferences };
  let { preferences = libraryGridPreferences }: Props = $props();

  /**
   * A photo album shown through the item view has the account's own choice for Work (FL-1398), the
   * one its grid draws and Settings and the Library's View menu set; Boards keep theirs per device.
   */
  const personal = $derived(preferences === libraryGridPreferences);
  const shown = $derived(personal ? libraryView.value.workNames : preferences.showFileNames);
  const toggle = () => (personal ? libraryView.set({ workNames: !shown }) : preferences.toggleFileNames());
  const label = $derived($t(shown ? 'frameleaf_library_hide_file_names' : 'frameleaf_library_show_file_names'));
</script>

<span class="fl-file-names-toggle" title={label}>
  <IconButton {label} pressed={shown} onclick={toggle}>
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
