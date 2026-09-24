<script lang="ts">
  import UserAvatar, { type Size } from '$lib/components/shared-components/UserAvatar.svelte';
  import type { ComponentProps } from 'svelte';

  /**
   * An account's photo in the September 24 shape: every people photo is a squircle
   * (apple-style.css "people photos: squircle everywhere", INTERACTION-REQUIREMENTS.md "Every people
   * photo, named or not, uses the squircle"). The mask works in every engine, so it wraps the
   * existing avatar instead of re-implementing its image and fallback.
   */
  interface Props {
    user: ComponentProps<typeof UserAvatar>['user'];
    size?: Size;
  }

  let { user, size = 'sm' }: Props = $props();
</script>

<span class="person-photo" aria-hidden="true"><UserAvatar {user} {size} noTitle /></span>

<style>
  .person-photo {
    display: inline-flex;
    flex-shrink: 0;
    -webkit-mask: var(--fl-squircle, none) center / 100% 100% no-repeat;
    mask: var(--fl-squircle, none) center / 100% 100% no-repeat;
  }
  /* An owner decision for every people photo: the squircle beats the avatar's own circle. */
  .person-photo :global(*) {
    border-radius: 0 !important;
  }
</style>
