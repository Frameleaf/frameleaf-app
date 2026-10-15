<script lang="ts">
  import type { SharedLinkResponseDto } from '@frameleaf/sdk';
  let { sharedLink }: { sharedLink: SharedLinkResponseDto } = $props();
</script>

<output data-testid="shared-link-id">{sharedLink.id}</output>
