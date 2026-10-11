<script lang="ts">
  /**
   * Your preferences › Downloads (FL-368, after the approved prototype; the preferences are FL-77's).
   * The size a big download is split at is a choice of three, said back as what a download would
   * look like. It is stored as an exact byte count and an unchanged size is never re-sent, so a size
   * set elsewhere to any other number is shown as "Custom" and kept exactly until another choice
   * replaces it. Changes wait for the Save bar.
   */
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import OwnPreferencesForm from '$lib/components/frameleaf/settings/OwnPreferencesForm.svelte';
  import { archiveSizeToGib, gibToArchiveSize, type AccountPreferenceKey } from '$lib/frameleaf/account-preferences';
  import { createOwnPreferencesDraft } from '$lib/frameleaf/own-preferences-draft';
  import { locale, t } from 'svelte-i18n';

  const keys: AccountPreferenceKey[] = ['download.archiveSize', 'download.includeEmbeddedVideos'];
  const store = createOwnPreferencesDraft(keys);
  const draft = $derived(store.draft);

  const SIZES = [2, 4, 10];
  const RECOMMENDED = 4;
  /** The album size the example sentence is about. */
  const EXAMPLE_GIB = 25;

  const sizeOf = (gib: number) => gibToArchiveSize(gib);
  const saved = $derived(store.baseline['download.archiveSize']);
  const current = $derived(draft['download.archiveSize']);
  const number = (value: number) => value.toLocaleString($locale ?? 'en', { maximumFractionDigits: 2 });
  const options = $derived([
    ...SIZES.map((gib) => ({
      value: String(sizeOf(gib)),
      label: $t(
        gib === RECOMMENDED ? 'frameleaf_prefs_downloads_size_recommended' : 'frameleaf_prefs_downloads_size_gb',
        {
          values: { size: gib },
        },
      ),
    })),
    // A size saved outside the choices stays offered, so choosing another one can be undone before saving.
    ...(saved !== null && SIZES.every((gib) => sizeOf(gib) !== saved)
      ? [
          {
            value: String(saved),
            label: `${$t('frameleaf_prefs_downloads_size_custom')} (${$t('frameleaf_prefs_downloads_size_gb', {
              values: { size: number(archiveSizeToGib(saved) ?? 0) },
            })})`,
          },
        ]
      : []),
  ]);
  const files = $derived(
    current ? Math.max(1, Math.ceil(EXAMPLE_GIB / (archiveSizeToGib(current) || EXAMPLE_GIB))) : undefined,
  );
</script>

<OwnPreferencesForm {store}>
  <KitPage>
    <Section title={$t('frameleaf_prefs_downloads_big')} description={$t('frameleaf_prefs_downloads_big_description')}>
      <Row
        label={$t('frameleaf_prefs_downloads_split')}
        help={files === undefined
          ? undefined
          : $t('frameleaf_prefs_downloads_split_help', { values: { count: files } })}
      >
        <SegmentedControl
          label={$t('frameleaf_prefs_downloads_split')}
          {options}
          value={String(current)}
          onChange={(value) => store.set('download.archiveSize', Number(value))}
        />
      </Row>
    </Section>

    <Section title={$t('frameleaf_prefs_downloads_contains')}>
      <Row label={$t('frameleaf_prefs_downloads_motion')} help={$t('frameleaf_prefs_downloads_motion_help')}>
        <Switch
          label={$t('frameleaf_prefs_downloads_motion_label')}
          checked={draft['download.includeEmbeddedVideos']}
          onChange={(value) => store.set('download.includeEmbeddedVideos', value)}
        />
      </Row>
    </Section>
  </KitPage>
</OwnPreferencesForm>
