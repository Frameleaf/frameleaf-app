<script lang="ts">
  import UserAvatar, { type Size } from '$lib/components/shared-components/UserAvatar.svelte';
  import type { ComponentProps } from 'svelte';

  /**
   * An account's photo in the September 24 shape: every people photo is a squircle
   * (apple-style.css "people photos: squircle everywhere"). The mask works in every engine, so it wraps the
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
  /*
   * The people photo shape comes from the foundation token (--fl-squircle in app.css: a rounded
   * square since FL-1395); the same shape is supplied here in case the token is missing, so the
   * people photo is never a circle.
   */
  .person-photo {
    --person-squircle: var(
      --fl-squircle,
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='18'/%3E%3C/svg%3E")
    );
    display: inline-flex;
    flex-shrink: 0;
    -webkit-mask: var(--person-squircle) center / 100% 100% no-repeat;
    mask: var(--person-squircle) center / 100% 100% no-repeat;
  }
  /* An owner decision for every people photo: the shared shape beats the avatar's own circle. */
  .person-photo :global(*) {
    border-radius: 0 !important;
  }
</style>
