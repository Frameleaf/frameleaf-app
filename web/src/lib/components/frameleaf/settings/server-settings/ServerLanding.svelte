<script lang="ts">
  /**
   * Server & updates (FL-368, after the approved prototype `settings-v2/server/server-updates.jsx`):
   * opens on the update status, lists the three household pages with their current state, and keeps
   * the rest behind one closed "Advanced" group. Every state comes from the saved settings and from
   * what the server last recorded about its version check.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { askInstalledVersion, updateState } from '$lib/components/frameleaf/settings/server-settings/update-status';
  import { ADVANCED_SECTIONS, commandCenterUrl, type SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { websocketStore } from '$lib/stores/websocket';
  import { semverToName } from '$lib/utils';
  import { getVersionCheck } from '@frameleaf/sdk';
  import { mdiCheckDecagramOutline, mdiUpdate } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let { sections }: { sections: SettingsHostSection[] } = $props();

  const { serverVersion } = websocketStore;
  const saved = $derived(getSystemConfigDraft()?.baseline);

  let checkedAt = $state<string | null>(null);
  let newest = $state<string | null>(null);
  onMount(async () => {
    try {
      const recorded = await getVersionCheck();
      checkedAt = recorded.checkedAt;
      newest = recorded.releaseVersion;
    } catch {
      // The page still says what is installed.
    }
  });

  let asked = $state<string>();
  onMount(() => void askInstalledVersion().then((name) => (asked = name)));
  const installed = $derived($serverVersion ? semverToName($serverVersion) : asked);
  const version = (name?: string | null) => (name ?? '').replace(/^v/, '');
  const looking = $derived(saved?.newVersionCheck.enabled ?? false);
  const answer = $derived(updateState({ looking, installed, newest, checkedAt }));
  const when = $derived(checkedAt ? (DateTime.fromISO(checkedAt).toRelative({ locale: $locale }) ?? '') : '');
  const values = $derived({ installed: version(installed), newest: version(newest), when });

  const hero = $derived(
    answer === 'available'
      ? {
          tone: 'warn' as const,
          icon: mdiUpdate,
          title: $t('frameleaf_server_updates_available', { values }),
          body: $t('frameleaf_server_updates_available_body', { values }),
        }
      : answer === 'current'
        ? {
            tone: 'good' as const,
            icon: mdiCheckDecagramOutline,
            title: $t('frameleaf_server_updates_current', { values }),
            body: $t('frameleaf_server_updates_current_body', { values }),
          }
        : {
            tone: 'quiet' as const,
            icon: mdiUpdate,
            title: installed
              ? $t('frameleaf_server_updates_running', { values })
              : $t('frameleaf_server_updates_running_unknown'),
            body:
              answer === 'off' ? $t('frameleaf_server_updates_off_body') : $t('frameleaf_server_updates_waiting_body'),
          },
  );

  /** What a row says under its name: the current state where the saved settings give one. */
  const stateOf = (section: SettingsHostSection) => {
    if (!saved) {
      return section.subtitle;
    }
    switch (section.key) {
      case 'server': {
        const name = saved.server.name.trim();
        return name
          ? $t('frameleaf_server_landing_name', { values: { name } })
          : $t('frameleaf_server_landing_name_none');
      }
      case 'location': {
        return saved.map.enabled
          ? saved.reverseGeocoding.enabled
            ? $t('frameleaf_server_landing_maps_both')
            : $t('frameleaf_server_landing_maps_map_only')
          : saved.reverseGeocoding.enabled
            ? $t('frameleaf_server_landing_maps_places_only')
            : $t('frameleaf_server_landing_maps_off');
      }
      default: {
        return section.subtitle;
      }
    }
  };
  const advanced = ADVANCED_SECTIONS.server ?? [];
  const rows = (behind: boolean) =>
    sections
      .filter((section) => advanced.includes(section.key) === behind)
      .map((section): LinkRow => ({
        icon: section.icon,
        title: section.title,
        body: stateOf(section),
        href: commandCenterUrl('server', section.key),
      }));
</script>

<KitPage>
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_server_updates_label')}
  >
    {#snippet actions()}
      <Button onclick={() => goto(commandCenterUrl('server', 'version-check'))}>
        {$t('frameleaf_cc_section_versions')}
      </Button>
    {/snippet}
  </Hero>

  <Section title={$t('frameleaf_server_landing_this')}>
    <Links stacked rows={rows(false)} />
    <Advanced>
      <Links stacked rows={rows(true)} />
    </Advanced>
  </Section>
</KitPage>
