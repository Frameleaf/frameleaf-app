<script lang="ts">
  import ServerAboutItem from '$lib/components/ServerAboutItem.svelte';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { type ServerAboutResponseDto, type ServerVersionHistoryResponseDto } from '@immich/sdk';
  import { Alert, Label, Modal, ModalBody, Text } from '@immich/ui';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  // FL-135: the symbol is imported unmodified from the authorized brand kit (never redrawn);
  // see docs/docs/developer/frameleaf-plan/06-brand-assets.md.
  import symbolUrl from '../assets/frameleaf/frameleaf-symbol.svg?url';

  interface Props {
    onClose: () => void;
    info: ServerAboutResponseDto;
    versions: ServerVersionHistoryResponseDto[];
  }

  let { onClose, info, versions }: Props = $props();

  // The upstream `ServerAboutItem` grid below is retained Immich/dependency attribution and is
  // left as-is, including its own "Immich" row.
  const licenceUrl = 'https://github.com/immich-app/immich/blob/main/LICENSE';
</script>

<Modal title={$t('frameleaf_about_menu_item')} {onClose}>
  <ModalBody>
    <div class="mb-4 flex items-center gap-3">
      <img src={symbolUrl} alt="" width="40" height="40" />
      <div>
        <Text size="large" fontWeight="bold">{$t('frameleaf_about_menu_item')}</Text>
        <Text size="small" color="muted">{$t('frameleaf_about_version', { values: { version: info.version } })}</Text>
      </div>
    </div>

    <p class="mb-4 text-sm text-gray-600 dark:text-gray-300">
      <FormatMessage key="frameleaf_about_attribution">
        {#snippet children({ tag, message })}
          {#if tag === 'upstream'}
            <a
              class="font-medium underline"
              href="https://github.com/immich-app/immich"
              target="_blank"
              rel="noopener noreferrer">{message}</a
            >
          {:else if tag === 'licence'}
            <a class="font-medium underline" href={licenceUrl} target="_blank" rel="noopener noreferrer">{message}</a>
          {:else}
            {message}
          {/if}
        {/snippet}
      </FormatMessage>
    </p>

    <div class="flex flex-col gap-4 sm:grid sm:grid-cols-2">
      {#if info.sourceRef === 'main' && info.repository === 'immich-app/immich'}
        <Alert color="warning" title={$t('main_branch_warning')} class="col-span-full" size="small" />
      {/if}

      <ServerAboutItem id="immich" title="Immich" version={info.version} versionHref={info.versionUrl} />
      <ServerAboutItem id="exif" title="ExifTool" version={info.exiftool} />
      <ServerAboutItem id="nodejs" title="Node.js" version={info.nodejs} />
      <ServerAboutItem id="libvips" title="Libvips" version={info.libvips} />
      <ServerAboutItem
        id="imagemagick"
        title="ImageMagick"
        version={info.imagemagick}
        class={(info.imagemagick?.length || 0) > 10 ? 'col-span-2' : ''}
      />
      <ServerAboutItem
        id="ffmpeg"
        title="FFmpeg"
        version={info.ffmpeg}
        class={(info.ffmpeg?.length || 0) > 10 ? 'col-span-2' : ''}
      />

      {#if info.repository && info.repositoryUrl}
        <ServerAboutItem
          id="repository"
          title={$t('repository')}
          version={info.repository}
          versionHref={info.repositoryUrl}
        />
      {/if}

      {#if info.sourceRef && info.sourceCommit && info.sourceUrl}
        <ServerAboutItem
          id="source"
          title={$t('source')}
          version="{info.sourceRef}@{info.sourceCommit.slice(0, 9)}"
          versionHref={info.sourceUrl}
        />
      {/if}

      {#if info.build && info.buildUrl}
        <ServerAboutItem id="build" title={$t('build')} version={info.build} versionHref={info.buildUrl} />
      {/if}

      {#if info.buildImage && info.buildImageUrl}
        <ServerAboutItem
          id="build-image"
          title={$t('build_image')}
          version={info.buildImage}
          versionHref={info.buildImageUrl}
        />
      {/if}

      <div class="col-span-full">
        <Label size="small" color="primary" for="version-history">{$t('version_history')}</Label>
        <ul id="version-history" class="list-none">
          {#each versions.slice(0, 5) as item (item.id)}
            {@const createdAt = DateTime.fromISO(item.createdAt)}
            <li>
              <span
                class="pb-2 text-xs immich-form-label"
                id="version-history"
                title={createdAt.toLocaleString(DateTime.DATETIME_SHORT_WITH_SECONDS, { locale: $locale })}
              >
                {$t('version_history_item', {
                  values: {
                    version: item.version,
                    date: createdAt.toLocaleString(
                      {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      },
                      { locale: $locale },
                    ),
                  },
                })}
              </span>
            </li>
          {/each}
        </ul>
      </div>
    </div>
  </ModalBody>
</Modal>
