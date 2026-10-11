<script lang="ts">
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import { commandCenterUrl, type SettingsHostSection } from '$lib/frameleaf/settings-areas';

  let { sections }: { sections: SettingsHostSection[] } = $props();
</script>

<KitPage>
  <Links
    stacked
    rows={sections.map((section) => ({
      icon: section.icon,
      title: section.title,
      body: section.subtitle,
      href: commandCenterUrl('notifications', section.key),
    }))}
  />
</KitPage>
