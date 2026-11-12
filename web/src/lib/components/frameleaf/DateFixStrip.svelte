<script lang="ts">
  /**
   * FL-943: a row of photos with the time each has now, struck through, and the time a fix gives it underneath (the
   * prototype's `.ld-strip`, `settings-v2/care/doctor.jsx`). Shared by the Date & Time Doctor's cards and the
   * timeline's "Fix dates…" dialog. A photo without an `after` is only shown as it is now.
   */
  import { stripTime } from '$lib/frameleaf/date-doctor';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type DateDoctorTimeDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowDown } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type StripItem = { assetId: string; before: DateDoctorTimeDto; after?: DateDoctorTimeDto };

  let { items, busy = false }: { items: StripItem[]; busy?: boolean } = $props();

  const lang = $derived($locale ?? 'en');
</script>

<ul class="strip" aria-label={$t('frameleaf_date_doctor_before_after')} aria-busy={busy}>
  {#each items as item (item.assetId)}
    <li>
      <img src={getAssetMediaUrl({ id: item.assetId, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
      {#if item.after}
        <span class="before"
          ><span class="sr-only">{$t('frameleaf_date_doctor_now')}</span>{stripTime(item.before, lang)}</span
        >
        <Icon icon={mdiArrowDown} size="16" aria-hidden />
        <strong><span class="sr-only">{$t('frameleaf_date_doctor_after')}</span>{stripTime(item.after, lang)}</strong>
      {:else}
        <span>{stripTime(item.before, lang)}</span>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .strip {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--fl-space-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .strip[aria-busy='true'] {
    opacity: 0.6;
  }
  li {
    display: grid;
    justify-items: start;
    gap: 6px;
    min-width: 0;
    font-size: var(--fl-font-small);
  }
  li :global(svg) {
    color: var(--fl-muted);
  }
  img {
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-sm);
  }
  /* two photos a row on a phone, not one tall one */
  @media (max-width: 620px) {
    .strip {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--fl-space-3);
    }
  }
  .before {
    color: var(--fl-muted);
    text-decoration: line-through;
  }
</style>
