<script lang="ts">
  /**
   * A shoot in the RAW develop editor (FL-420): Photography's "Open in RAW editor". Loads the shoot's
   * RAW photographs (the chosen ones, or every one not rejected) and rates through the shoot, as
   * culling does.
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowLeft, mdiCameraOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import RawDevelopEditor from '$lib/components/frameleaf/develop/RawDevelopEditor.svelte';
  import { isRawName } from '$lib/frameleaf/library-care';
  import { loadPhotos, loadWorkspace, ratePhoto, type Photo } from '$lib/frameleaf/photography/api';
  import type { DevelopPhoto } from '$lib/frameleaf/raw-develop-session.svelte';

  let {
    shootId,
    photoId,
    only,
    onBack,
    onProof,
  }: {
    shootId: string;
    photoId?: string;
    only: string[] | null;
    onBack: () => void;
    onProof: () => void;
  } = $props();

  /** A shoot larger than this opens its first photographs; the rest stay in Photography. */
  const MAX_PHOTOS = 2000;

  let phase = $state<'loading' | 'ready' | 'failed' | 'missing'>('loading');
  let shoot = $state<{ id: string; name: string } | null>(null);
  let photos = $state<DevelopPhoto[]>([]);

  const develops = (photo: Photo) =>
    isRawName(photo.fileName) && (only ? only.includes(photo.id) : photo.rating !== -1 || photo.id === photoId);

  async function load() {
    phase = 'loading';
    try {
      const workspace = await loadWorkspace();
      const found = workspace.shoots.find((item) => item.id === shootId);
      if (!found) {
        phase = 'missing';
        return;
      }
      shoot = { id: found.id, name: found.name };
      const all: Photo[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await loadPhotos(shootId, cursor);
        all.push(...page.photos);
        cursor = page.nextCursor;
      } while (cursor && all.length < MAX_PHOTOS);
      photos = all.filter(develops).map((photo) => ({
        id: photo.id,
        fileName: photo.fileName,
        rating: photo.rating === -1 ? null : photo.rating,
        canRate: photo.canRate,
        edited: !!photo.currentRevisionId,
      }));
      phase = 'ready';
    } catch {
      phase = 'failed';
    }
  }

  onMount(() => void load());
</script>

{#if phase === 'ready' && shoot && photos.length > 0}
  <RawDevelopEditor
    {photos}
    initialId={photoId}
    {shoot}
    {onBack}
    {onProof}
    rate={(id, rating) => ratePhoto(shootId, id, rating)}
  />
{:else}
  <div class="rde-route-message">
    {#if phase === 'loading'}
      <p role="status">{$t('frameleaf_develop_status_loading')}</p>
    {:else if phase === 'failed'}
      <InlineError message={$t('frameleaf_develop_shoot_failed')} onRetry={() => void load()} />
    {:else}
      <Icon icon={mdiCameraOutline} size="2rem" aria-hidden={true} />
      <h2>{phase === 'missing' ? $t('frameleaf_develop_shoot_missing') : $t('frameleaf_develop_no_raw')}</h2>
      <p>{phase === 'missing' ? $t('frameleaf_develop_shoot_missing_body') : $t('frameleaf_develop_no_raw_body')}</p>
    {/if}
    {#if phase !== 'loading'}<button type="button" class="fl-control rde-route-back" onclick={onBack}
        ><Icon icon={mdiArrowLeft} size="1rem" aria-hidden={true} />{$t('frameleaf_develop_back_to_shoot')}</button
      >{/if}
  </div>
{/if}

<style>
  .rde-route-message {
    flex: 1;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-6) var(--fl-space-4);
    color: var(--fl-muted);
    text-align: center;
  }
  .rde-route-message h2 {
    margin: 0;
    color: var(--fl-text);
    font-size: var(--fl-font-headline);
    font-weight: 600;
  }
  .rde-route-message p {
    margin: 0;
    max-width: 420px;
  }
  .rde-route-back {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    padding: 0.4375rem 0.75rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    cursor: pointer;
  }
</style>
