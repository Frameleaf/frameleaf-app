<script lang="ts">
  /**
   * Library care → Repair suggestions: which fixes Frameleaf looks for and suggests (FL-69). The
   * repair tools themselves are listed once, in Library care's Tools group, under the names
   * Utilities uses; this page no longer repeats them as cards under other names (design review
   * finding 67).
   */
  import LibraryCareToggles from '$lib/components/frameleaf/settings/LibraryCareToggles.svelte';
</script>

<LibraryCareToggles section="repair" />
