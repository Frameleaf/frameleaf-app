<script lang="ts">
  /**
   * Maintenance (FL-366, after the approved prototype `settings-v2/care/landing.jsx`): opens on whether
   * Frameleaf is running normally or paused, then where to go. Integrity checks are no longer a page of
   * their own here: the row opens the one File checks page in Library care, and Backups & restore opens
   * the Backup page.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { backupPageUrl, commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getMaintenanceStatus } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiBackupRestore,
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiFileSearchOutline,
    mdiPauseCircleOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let on = $state(false);

  $effect(() => {
    let current = true;
    void getMaintenanceStatus()
      .then((status) => {
        if (current) {
          on = status.active;
        }
      })
      .catch(() => {
        // a server in maintenance mode serves only the maintenance page, so "running" is the safe reading
      });
    return () => {
      current = false;
    };
  });

  const modeUrl = commandCenterUrl('maintenance', 'mode');
</script>

<KitPage>
  <Hero
    tone={on ? 'warn' : 'good'}
    icon={on ? mdiPauseCircleOutline : mdiCheckCircleOutline}
    title={on ? $t('frameleaf_carehome_maint_on') : $t('frameleaf_carehome_maint_ok')}
    body={on ? $t('frameleaf_carehome_maint_on_body') : $t('frameleaf_carehome_maint_ok_body')}
    label={$t('frameleaf_carehome_maint_label')}
  >
    {#snippet actions()}
      <Button variant={on ? 'primary' : 'default'} onclick={() => goto(modeUrl)}>
        {on ? $t('frameleaf_carehome_maint_end') : $t('frameleaf_carehome_maint_mode')}
        <Icon icon={mdiChevronRight} size="1em" aria-hidden />
      </Button>
    {/snippet}
  </Hero>

  <Section title={$t('frameleaf_carehome_maint_need')}>
    <Links
      rows={[
        {
          icon: mdiPauseCircleOutline,
          title: $t('frameleaf_carehome_maint_mode'),
          body: $t('frameleaf_carehome_maint_mode_body'),
          href: modeUrl,
        },
        {
          icon: mdiBackupRestore,
          title: $t('frameleaf_carehome_maint_backup'),
          body: $t('frameleaf_carehome_maint_backup_body'),
          href: backupPageUrl(),
        },
        {
          icon: mdiFileSearchOutline,
          title: $t('frameleaf_carehome_row_checks'),
          body: $t('frameleaf_carehome_maint_checks_body'),
          href: commandCenterUrl('care', 'integrity-checks'),
        },
      ]}
    />
  </Section>
</KitPage>
