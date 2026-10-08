<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import type { PersonResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAccount } from '@mdi/js';
  /**
   * Pass only currently authorized evidence. Clear on lock, account change or revocation.
   * `size` defaults to the 24px chip/picker size; the People grid and person page pass a
   * larger value for the face photograph, per the September 22 revision. Every people photo
   * is a squircle (apple-style.css:137-148): the global `fl-squircle` mask in app.css.
   *
   * `fluid` lets the face shrink with a narrow column: `size` becomes the most it grows to and the
   * parent sets the width. `heroKey` marks it as one end of a card-to-page Hero pairing
   * (`data-fl-shared`, $lib/frameleaf/motion heroNavigation); `heroPage` marks the end that is the
   * page the card opens.
   *
   * A face that does not load is never an error message: the person's initials, or a plain
   * silhouette when they have no name yet, on a neutral tile. The avatar itself is decorative
   * (`aria-hidden`); whoever shows it names the person beside it or on the control, so the name is
   * always there for assistive technology.
   */
  let {
    person,
    size = 24,
    fluid = false,
    heroKey,
    heroPage = false,
    onUnavailable,
  }: {
    person?: PersonResponseDto;
    size?: number;
    fluid?: boolean;
    heroKey?: string;
    heroPage?: boolean;
    onUnavailable?: () => void;
  } = $props();

  /** The face (person and revision) whose picture did not load; a new picture gets a new try. */
  let failedKey = $state<string>();
  const faceKey = $derived(person ? person.id + person.updatedAt : undefined);

  const initials = $derived(
    (person?.name ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => [...word][0]?.toLocaleUpperCase() ?? '')
      .join(''),
  );
</script>

{#if person}
  {#key person.id + person.updatedAt}
    <span
      class="avatar fl-squircle"
      class:fluid
      style:width={fluid ? undefined : `${size}px`}
      style:height={fluid ? undefined : `${size}px`}
      style:max-width={fluid ? `${size}px` : undefined}
      data-fl-shared={heroKey}
      data-fl-shared-page={heroKey && heroPage ? '' : undefined}
      aria-hidden="true"
    >
      {#if failedKey === faceKey}
        <span class="placeholder" data-testid="person-avatar-placeholder">
          {#if initials}
            <span class="initials">{initials}</span>
          {:else}
            <Icon icon={mdiAccount} size={ICON_SIZE.hero} aria-hidden />
          {/if}
        </span>
      {:else}
        <ImageThumbnail
          url={getPeopleThumbnailUrl(person)}
          altText=""
          widthStyle="100%"
          onComplete={(errored) => {
            if (errored) {
              failedKey = faceKey;
              onUnavailable?.();
            }
          }}
        />
      {/if}
    </span>
  {/key}
{/if}

<style>
  .avatar {
    display: inline-flex;
    overflow: hidden;
    flex-shrink: 0;
  }
  .avatar.fluid {
    width: 100%;
    aspect-ratio: 1;
  }

  /* The picture did not load: initials or a silhouette, sized to the tile whatever its size. */
  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    container-type: size;
    background: var(--fl-raised);
    color: var(--fl-muted);
  }

  .initials {
    font-family: var(--fl-family-ui);
    font-size: 40cqmin;
    font-weight: 600;
    line-height: 1;
    letter-spacing: var(--fl-tracking-headline);
    user-select: none;
  }

  .placeholder :global(svg) {
    width: 62cqmin;
    height: 62cqmin;
  }
</style>
