<script lang="ts">
  /**
   * "Bring everything together" (FL-176): where Google Photos and iCloud Photos imports live, as
   * pointers only. Neutral icons, no service logos; nothing starts during setup.
   */
  import symbolUrl from '$lib/assets/frameleaf/frameleaf-symbol.svg?url';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowRightThin, mdiClockOutline, mdiCloudOutline, mdiImageMultipleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  const sources = [
    {
      id: 'google',
      title: 'frameleaf_setup_import_google',
      via: 'frameleaf_setup_import_google_via',
      body: 'frameleaf_setup_import_google_body',
      where: 'frameleaf_setup_import_google_where',
      icon: mdiImageMultipleOutline,
    },
    {
      id: 'icloud',
      title: 'frameleaf_setup_import_icloud',
      via: 'frameleaf_setup_import_icloud_via',
      body: 'frameleaf_setup_import_icloud_body',
      where: 'frameleaf_setup_import_icloud_where',
      icon: mdiCloudOutline,
    },
  ] as const;
</script>

<p class="frs-lead">{$t('frameleaf_setup_imports_lead')}</p>
<div class="frs-imports">
  {#each sources as source (source.id)}
    <article class="frs-import {source.id}">
      <div class="frs-import-art" aria-hidden="true">
        {#each [0, 1, 2, 3, 4, 5] as tile (tile)}
          <span class="frs-import-tile" style:--i={tile}></span>
        {/each}
        <span class="frs-import-badge"><Icon icon={source.icon} size="26" /></span>
        <span class="frs-import-arrow"><Icon icon={mdiArrowRightThin} size="28" /></span>
        <span class="frs-import-target"><img src={symbolUrl} alt="" /></span>
      </div>
      <div class="frs-import-copy">
        <h2>{$t(source.title)} <small>{$t(source.via)}</small></h2>
        <p>{$t(source.body)}</p>
        <!-- Plain text: until setup finishes, any link out of it only leads back here. -->
        <p class="frs-later">
          <Icon icon={mdiClockOutline} size="14" aria-hidden={true} />{$t(source.where)}
        </p>
      </div>
    </article>
  {/each}
</div>
