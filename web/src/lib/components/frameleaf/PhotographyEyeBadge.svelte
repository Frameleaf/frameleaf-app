<script lang="ts" module>
  import type { PhotoEyes } from '$lib/frameleaf/photography/api';

  /** FL-891: what a photo's badge says: closed eyes first, then soft focus; nothing when every face is fine. */
  export const eyeBadge = (eyes: PhotoEyes | undefined) =>
    !eyes ? null : eyes.closedCount > 0 ? 'closed' : eyes.softCount > 0 ? 'soft' : null;
</script>

<script lang="ts">
  /**
   * FL-891: a shoot photo's eye check, as approved in the FL-821 prototype: a badge on the tile when a face has
   * closed or soft eyes, with each face's result on hover, focus or tap.
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiEyeOffOutline, mdiEyeOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = { eyes: PhotoEyes | undefined; fileName: string };
  let { eyes, fileName }: Props = $props();

  const id = $props.id();
  let open = $state(false);
  const badge = $derived(eyeBadge(eyes));
  const label = $derived(
    badge === 'closed' ? $t('frameleaf_photography_eyes_closed') : $t('frameleaf_photography_eyes_soft'),
  );
  const faceLabel = (face: PhotoEyes['faces'][number]) =>
    face.closed
      ? $t('frameleaf_photography_eyes_closed')
      : face.soft
        ? $t('frameleaf_photography_eyes_soft')
        : face.checked
          ? $t('frameleaf_photography_eyes_open')
          : $t('frameleaf_photography_eyes_unchecked');
</script>

{#if eyes && badge}
  <div class="phw-eye" data-open={open}>
    <button
      type="button"
      class="fl-no-press"
      aria-label="{label}. {$t('frameleaf_photography_eyes_check_for', { values: { name: fileName } })}"
      aria-describedby="{id}-faces"
      aria-expanded={open}
      onclick={() => (open = !open)}
      onkeydown={(event) => {
        if (event.key === 'Escape') {
          open = false;
        }
      }}
      ><Icon
        icon={badge === 'closed' ? mdiEyeOffOutline : mdiEyeOutline}
        size="0.875rem"
        aria-hidden={true}
      />{label}</button
    >
    <div class="phw-eye-faces" id="{id}-faces">
      <strong>{$t('frameleaf_photography_eyes_check_for', { values: { name: fileName } })}</strong>
      <ol>
        {#each eyes.faces as face, index (index)}<li>
            {$t('frameleaf_photography_eyes_face', { values: { number: index + 1, state: faceLabel(face) } })}
          </li>{/each}
      </ol>
    </div>
  </div>
{/if}
