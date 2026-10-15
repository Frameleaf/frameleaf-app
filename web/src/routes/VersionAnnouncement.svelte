<script lang="ts">
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import VersionAnnouncementModal from '$lib/modals/VersionAnnouncementModal.svelte';
  import { semverToName } from '$lib/utils';
  import { ReleaseType, type ReleaseEventV1 } from '@frameleaf/sdk';
  import { modalManager } from '@frameleaf/ui';
  import { onDestroy } from 'svelte';

  let modal = $state<{
    onClose: Promise<void>;
    close: () => Promise<void>;
  }>();

  let generation = 0;
  onDestroy(() => {
    generation++;
  });

  const onReleaseEvent = async (release: ReleaseEventV1) => {
    if (!release.isAvailable || !authManager.authenticated || !authManager.user.isAdmin) {
      return;
    }

    const releaseVersion = semverToName(release.releaseVersion);
    const serverVersion = semverToName(release.serverVersion);

    if (
      !release.type ||
      release.type === ReleaseType.Patch ||
      release.type === ReleaseType.Prepatch ||
      localStorage.getItem('appVersion') === releaseVersion
    ) {
      return;
    }

    const owner = ++generation;
    const isCurrentSession = authManager.captureSession();
    try {
      await modal?.close();
      if (owner !== generation || !isCurrentSession()) {
        return;
      }

      modal = modalManager.open(VersionAnnouncementModal, { serverVersion, releaseVersion });

      void modal.onClose
        .then(() => {
          if (owner === generation && isCurrentSession()) {
            localStorage.setItem('appVersion', releaseVersion);
          }
        })
        .catch((error) => console.error('Error [VersionAnnouncementBox]:', error));
    } catch (error) {
      console.error('Error [VersionAnnouncementBox]:', error);
    }
  };
</script>

<OnEvents {onReleaseEvent} />
