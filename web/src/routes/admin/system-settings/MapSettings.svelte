<script lang="ts">
  /**
   * Server & updates › Maps & places (FL-368, after the approved prototype
   * `settings-v2/server/server-updates.jsx`): the two switches on the page itself, each saying what
   * it does and what turning it off costs, and the map's look as one choice. The two long style
   * addresses stay behind Advanced and can only be typed once "Custom" is chosen.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { helpLinks } from '$lib/frameleaf/help-links.svelte';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { t } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const map = $derived(settingsDraft.draft.map);
  const standard = $derived(settingsDraft.defaults.map);

  // FL-135: this installation's documentation, or no link at all
  const geocodingDocs = $derived(helpLinks.docs('features/reverse-geocoding'));

  /** "Custom" is chosen, or the saved addresses are already not the standard map's. */
  let chosenCustom = $state(false);
  const differs = $derived(map.lightStyle !== standard.lightStyle || map.darkStyle !== standard.darkStyle);
  const custom = $derived(chosenCustom || differs);
  const useStandard = () => {
    chosenCustom = false;
    map.lightStyle = standard.lightStyle;
    map.darkStyle = standard.darkStyle;
  };
</script>

<KitPage>
  <Section title={$t('frameleaf_server_maps_map')}>
    <Row
      label={$t('frameleaf_server_maps_show')}
      help={map.enabled ? $t('frameleaf_server_maps_show_on') : $t('frameleaf_server_maps_show_off')}
    >
      <Switch
        label={$t('frameleaf_server_maps_show')}
        checked={map.enabled}
        held={disabled}
        onChange={(value) => (settingsDraft.draft.map.enabled = value)}
      />
    </Row>
    <Row
      label={$t('frameleaf_server_maps_look')}
      help={custom ? $t('frameleaf_server_maps_look_custom') : $t('frameleaf_server_maps_look_standard')}
    >
      <SegmentedControl
        label={$t('frameleaf_server_maps_look')}
        options={[
          { value: 'standard', label: $t('frameleaf_server_maps_standard') },
          { value: 'custom', label: $t('frameleaf_server_maps_custom') },
        ]}
        value={custom ? 'custom' : 'standard'}
        disabled={disabled || !map.enabled}
        onChange={(value) => (value === 'custom' ? (chosenCustom = true) : useStandard())}
      />
    </Row>
    <Advanced open={custom}>
      <p class="hint">{$t('frameleaf_server_maps_style_about')}</p>
      <Row label={$t('frameleaf_server_maps_style_light')}>
        <Field
          wide
          type="url"
          label={$t('frameleaf_server_maps_style_light')}
          value={map.lightStyle}
          disabled={disabled || !map.enabled || !custom}
          onChange={(value) => (settingsDraft.draft.map.lightStyle = value)}
        />
      </Row>
      <Row label={$t('frameleaf_server_maps_style_dark')}>
        <Field
          wide
          type="url"
          label={$t('frameleaf_server_maps_style_dark')}
          value={map.darkStyle}
          disabled={disabled || !map.enabled || !custom}
          onChange={(value) => (settingsDraft.draft.map.darkStyle = value)}
        />
      </Row>
      {#if custom}
        <Row label={$t('frameleaf_server_maps_back')} help={$t('frameleaf_server_maps_back_help')}>
          <Button {disabled} onclick={useStandard}>{$t('frameleaf_server_maps_back_action')}</Button>
        </Row>
      {/if}
    </Advanced>
  </Section>

  <Section title={$t('frameleaf_server_maps_places')}>
    <Row
      label={$t('frameleaf_server_maps_name')}
      help={settingsDraft.draft.reverseGeocoding.enabled
        ? $t('frameleaf_server_maps_name_on')
        : $t('frameleaf_server_maps_name_off')}
      link={geocodingDocs
        ? { text: $t('frameleaf_server_maps_name_more'), href: geocodingDocs, external: true }
        : undefined}
    >
      <Switch
        label={$t('frameleaf_server_maps_name')}
        checked={settingsDraft.draft.reverseGeocoding.enabled}
        held={disabled}
        onChange={(value) => (settingsDraft.draft.reverseGeocoding.enabled = value)}
      />
    </Row>
  </Section>

  <SettingActions keys={['map', 'reverseGeocoding']} {disabled} />
</KitPage>

<style>
  .hint {
    max-width: 640px;
    margin: 0;
    padding-bottom: var(--fl-space-4);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
</style>
