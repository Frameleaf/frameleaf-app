<script lang="ts">
  import { ocrManager } from '$lib/stores/ocr.svelte';
  import { IconButton } from '@frameleaf/ui';
  import { mdiTextRecognition } from '@mdi/js';
  import { t } from 'svelte-i18n';
</script>

<IconButton
  title={ocrManager.showOverlay ? $t('hide_text_recognition') : $t('show_text_recognition')}
  icon={mdiTextRecognition}
  class={ocrManager.showOverlay ? 'dark bg-primary text-white' : 'dark text-white'}
  color="secondary"
  variant="ghost"
  shape="round"
  aria-label={$t('text_recognition')}
  onclick={() => ocrManager.toggleOcrBoundingBox()}
/>
