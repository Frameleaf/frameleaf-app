<script lang="ts">
  /**
   * Your preferences › Downloads (FL-368, after the approved prototype; the preferences are FL-77's).
   * ACCOUNT-P5: "What a download contains" comes first, with a details file beside each photo; the
   * server applies it to archives (shared links aside). There is no original-or-edited choice: each
   * photo downloads as it is shown, the version being viewed (owner, 2026-10-16).
   *
   * The size a big download is split at is a choice of three or "Custom" (a whole number of GB),
   * said back as what a download would look like. It is stored as an exact byte count and an
   * unchanged size is never re-sent, so a size set elsewhere to any other number is shown as
   * "Custom" and kept exactly until it is changed. Changes wait for the Save bar.
   *
   * D5: sizes are decimal GB (n × 1,000,000,000 bytes). A preset saved before D5 in binary bytes
   * (n × 1,073,741,824) still shows as that preset; picking a size saves the decimal value.
   */
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Amount from '$lib/components/frameleaf/settings/kit/Amount.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import OwnPreferencesForm from '$lib/components/frameleaf/settings/OwnPreferencesForm.svelte';
  import {
    archiveSizeToGb,
    gbToArchiveSize,
    isArchiveSizePreset,
    type AccountPreferenceKey,
  } from '$lib/frameleaf/account-preferences';
  import { createOwnPreferencesDraft } from '$lib/frameleaf/own-preferences-draft';
  import { t } from 'svelte-i18n';

  const keys: AccountPreferenceKey[] = [
    'download.includeEmbeddedVideos',
    'download.includeSidecar',
    'download.archiveSize',
  ];
  const store = createOwnPreferencesDraft(keys);
  const draft = $derived(store.draft);

  const SIZES = [2, 4, 10];
  const RECOMMENDED = 4;
  const CUSTOM = 'custom';
  /** The first size offered when "Custom" is chosen (the prototype's). */
  const CUSTOM_START_GB = 6;
  /** The album size the example sentence is about. */
  const EXAMPLE_GB = 25;

  const sizeOf = (gb: number) => gbToArchiveSize(gb);
  /** The preset a stored size is, in its decimal or its pre-D5 binary form. */
  const presetOf = (bytes: number | null) => SIZES.find((gb) => isArchiveSizePreset(bytes, gb));
  const isPreset = (bytes: number | null) => presetOf(bytes) !== undefined;
  const current = $derived(draft['download.archiveSize']);
  /** "Custom" was picked on this page; a size outside the presets shows as Custom anyway. */
  let customPicked = $state(false);
  // Saved or undone: the stored size alone decides again.
  $effect(() => {
    if (!store.dirty) {
      customPicked = false;
    }
  });
  const preset = $derived(presetOf(current));
  const choice = $derived(customPicked || preset === undefined ? CUSTOM : String(sizeOf(preset)));
  const customGb = $derived(Math.max(1, Math.round(archiveSizeToGb(current) ?? CUSTOM_START_GB)));
  const options = $derived([
    ...SIZES.map((gb) => ({
      value: String(sizeOf(gb)),
      label: $t(
        gb === RECOMMENDED ? 'frameleaf_prefs_downloads_size_recommended' : 'frameleaf_prefs_downloads_size_gb',
        {
          values: { size: gb },
        },
      ),
    })),
    { value: CUSTOM, label: $t('frameleaf_prefs_downloads_size_custom') },
  ]);
  const choose = (value: string) => {
    customPicked = value === CUSTOM;
    if (value !== CUSTOM) {
      store.set('download.archiveSize', Number(value));
    } else if (isPreset(current)) {
      store.set('download.archiveSize', sizeOf(CUSTOM_START_GB));
    }
  };
  const files = $derived(
    current ? Math.max(1, Math.ceil(EXAMPLE_GB / (archiveSizeToGb(current) || EXAMPLE_GB))) : undefined,
  );
</script>

<OwnPreferencesForm {store}>
  <KitPage>
    <Section title={$t('frameleaf_prefs_downloads_contains')}>
      <Row label={$t('frameleaf_prefs_downloads_motion')} help={$t('frameleaf_prefs_downloads_motion_help')}>
        <Switch
          label={$t('frameleaf_prefs_downloads_motion_label')}
          checked={draft['download.includeEmbeddedVideos']}
          onChange={(value) => store.set('download.includeEmbeddedVideos', value)}
        />
      </Row>
      <Row label={$t('frameleaf_prefs_downloads_details')} help={$t('frameleaf_prefs_downloads_details_help')}>
        <Switch
          label={$t('frameleaf_prefs_downloads_details_label')}
          checked={draft['download.includeSidecar']}
          onChange={(value) => store.set('download.includeSidecar', value)}
        />
      </Row>
    </Section>

    <Section title={$t('frameleaf_prefs_downloads_big')} description={$t('frameleaf_prefs_downloads_big_description')}>
      <Row
        label={$t('frameleaf_prefs_downloads_split')}
        help={files === undefined
          ? undefined
          : $t('frameleaf_prefs_downloads_split_help', { values: { count: files } })}
      >
        <!-- The prototype's order: the size field before the choice (the row wraps them on a phone). -->
        {#if choice === CUSTOM}
          <Amount
            label={$t('frameleaf_prefs_downloads_size_label')}
            unit={$t('frameleaf_prefs_downloads_size_unit')}
            min={1}
            max={100}
            value={customGb}
            onChange={(gb) => store.set('download.archiveSize', sizeOf(gb))}
          />
        {/if}
        <SegmentedControl label={$t('frameleaf_prefs_downloads_split')} {options} value={choice} onChange={choose} />
      </Row>
    </Section>
  </KitPage>
</OwnPreferencesForm>
