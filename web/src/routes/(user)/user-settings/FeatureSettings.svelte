<script lang="ts">
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetOrder, updateMyPreferences } from '@immich/sdk';
  import { Button, Field, NumberInput, Select, Switch, toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  // Albums
  let defaultAssetOrder = $state(authManager.preferences.albums?.defaultAssetOrder ?? AssetOrder.Desc);

  // Folders
  let foldersEnabled = $state(authManager.preferences.folders?.enabled ?? false);
  let foldersSidebar = $state(authManager.preferences.folders?.sidebarWeb ?? false);

  // Memories
  let memoriesEnabled = $state(authManager.preferences.memories?.enabled ?? true);
  let memoriesDuration = $state(authManager.preferences.memories?.duration ?? 5);
  let memoriesSidebar = $state(authManager.preferences.memories?.sidebarWeb ?? false);

  // People
  let peopleEnabled = $state(authManager.preferences.people?.enabled ?? false);
  let peopleSidebar = $state(authManager.preferences.people?.sidebarWeb ?? false);
  let peopleMinFaces = $state(authManager.preferences.people?.minimumFaces ?? serverConfigManager.value.minFaces);

  // Ratings
  let ratingsEnabled = $state(authManager.preferences.ratings?.enabled ?? false);

  // Shared links
  let sharedLinksEnabled = $state(authManager.preferences.sharedLinks?.enabled ?? true);
  let sharedLinkSidebar = $state(authManager.preferences.sharedLinks?.sidebarWeb ?? false);

  // Tags
  let tagsEnabled = $state(authManager.preferences.tags?.enabled ?? false);
  let tagsSidebar = $state(authManager.preferences.tags?.sidebarWeb ?? false);

  // Cast
  let gCastEnabled = $state(authManager.preferences.cast?.gCastEnabled ?? false);

  // Recently added
  let recentlyAddedSidebar = $state(authManager.preferences.recentlyAdded?.sidebarWeb ?? false);

  const handleSave = async () => {
    try {
      const response = await updateMyPreferences({
        userPreferencesUpdateDto: {
          albums: { defaultAssetOrder },
          folders: { enabled: foldersEnabled, sidebarWeb: foldersSidebar },
          memories: { enabled: memoriesEnabled, duration: memoriesDuration, sidebarWeb: memoriesSidebar },
          people: { enabled: peopleEnabled, sidebarWeb: peopleSidebar, minimumFaces: peopleMinFaces },
          ratings: { enabled: ratingsEnabled },
          sharedLinks: { enabled: sharedLinksEnabled, sidebarWeb: sharedLinkSidebar },
          tags: { enabled: tagsEnabled, sidebarWeb: tagsSidebar },
          cast: { gCastEnabled },
          recentlyAdded: { sidebarWeb: recentlyAddedSidebar },
        },
      });

      authManager.setPreferences(response);
      toastManager.primary($t('saved_settings'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_settings'));
    }
  };

  const onsubmit = (event: Event) => {
    event.preventDefault();
  };
</script>

<section class="my-4">
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" {onsubmit}>
      <div class="flex flex-col gap-4">
        <SettingGroup key="albums" title={$t('albums')} subtitle={$t('albums_feature_description')}>
          <div class="flex flex-col gap-4">
            <Field label={$t('albums_default_sort_order')} description={$t('albums_default_sort_order_description')}>
              <Select
                options={[
                  { label: $t('oldest_first'), value: AssetOrder.Asc },
                  { label: $t('newest_first'), value: AssetOrder.Desc },
                ]}
                bind:value={defaultAssetOrder}
              />
            </Field>
          </div>
        </SettingGroup>

        <SettingGroup key="folders" title={$t('folders')} subtitle={$t('folders_feature_description')}>
          <div class="flex flex-col gap-4">
            <Field label={$t('enable')}>
              <Switch bind:checked={foldersEnabled} />
            </Field>

            {#if foldersEnabled}
              <Field label={$t('sidebar')} description={$t('sidebar_display_description')}>
                <Switch bind:checked={foldersSidebar} />
              </Field>
            {/if}
          </div>
        </SettingGroup>

        <SettingGroup key="memories" title={$t('time_based_memories')} subtitle={$t('photos_from_previous_years')}>
          <div class="flex flex-col gap-4">
            <Field label={$t('enable')}>
              <Switch bind:checked={memoriesEnabled} />
            </Field>

            {#if memoriesEnabled}
              <Field label={$t('sidebar')} description={$t('sidebar_display_description')}>
                <Switch bind:checked={memoriesSidebar} />
              </Field>
            {/if}

            <Field label={$t('duration')} description={$t('time_based_memories_duration')}>
              <NumberInput bind:value={memoriesDuration} />
            </Field>
          </div>
        </SettingGroup>

        <SettingGroup key="people" title={$t('people')} subtitle={$t('people_feature_description')}>
          <div class="flex flex-col gap-4">
            <Field label={$t('enable')}>
              <Switch bind:checked={peopleEnabled} />
            </Field>

            {#if peopleEnabled}
              <Field label={$t('sidebar')} description={$t('sidebar_display_description')}>
                <Switch bind:checked={peopleSidebar} />
              </Field>
              <Field label={$t('minFaces')} description={$t('minFaces_description')}>
                <NumberInput bind:value={peopleMinFaces} />
              </Field>
            {/if}
          </div>
        </SettingGroup>

        <SettingGroup key="rating" title={$t('rating')} subtitle={$t('rating_description')}>
          <div class="flex flex-col gap-4">
            <Field label={$t('enable')}>
              <Switch bind:checked={ratingsEnabled} />
            </Field>
          </div>
        </SettingGroup>

        <SettingGroup key="shared-links" title={$t('shared_links')} subtitle={$t('shared_links_description')}>
          <div class="flex flex-col gap-4">
            <Field label={$t('enable')}>
              <Switch bind:checked={sharedLinksEnabled} />
            </Field>

            {#if sharedLinksEnabled}
              <Field label={$t('sidebar')} description={$t('sidebar_display_description')}>
                <Switch bind:checked={sharedLinkSidebar} />
              </Field>
            {/if}
          </div>
        </SettingGroup>

        <SettingGroup key="tags" title={$t('tags')} subtitle={$t('tag_feature_description')}>
          <div class="flex flex-col gap-4">
            <Field label={$t('enable')}>
              <Switch bind:checked={tagsEnabled} />
            </Field>

            {#if tagsEnabled}
              <Field label={$t('sidebar')} description={$t('sidebar_display_description')}>
                <Switch bind:checked={tagsSidebar} />
              </Field>
            {/if}
          </div>
        </SettingGroup>

        <SettingGroup key="cast" title={$t('cast')} subtitle={$t('cast_description')}>
          <div class="flex flex-col gap-4">
            <Field label={$t('gcast_enabled')} description={$t('gcast_enabled_description')}>
              <Switch bind:checked={gCastEnabled} />
            </Field>
          </div>
        </SettingGroup>

        <SettingGroup key="recentlyAdded" title={$t('recently_added')} subtitle={$t('recently_added_description')}>
          <div class="flex flex-col gap-4">
            <Field label={$t('sidebar')} description={$t('sidebar_display_description')}>
              <Switch bind:checked={recentlyAddedSidebar} />
            </Field>
          </div>
        </SettingGroup>

        <div class="flex justify-end">
          <Button shape="round" type="submit" size="small" onclick={() => handleSave()}>{$t('save')}</Button>
        </div>
      </div>
    </form>
  </div>
</section>
