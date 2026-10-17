<script lang="ts">
  import type { AssetResponseDto } from '@frameleaf/sdk';

  let { files }: { files: AssetResponseDto[] } = $props();
</script>

<p data-testid="file-count">{files.length}</p>
<p data-testid="file-name">{files[0]?.originalFileName}</p>
<p data-testid="file-size">{files[0]?.exifInfo?.fileSizeInByte}</p>
