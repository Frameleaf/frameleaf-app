<script lang="ts">
  /**
   * FL-176: a new server's first-run setup — welcome, how you'll sign in, the admin account (the
   * existing sign-up API), library, processing, protection, privacy, imports and ready — in place
   * of the plain admin registration form.
   */
  import FirstRunSetup from '$lib/components/frameleaf/setup/FirstRunSetup.svelte';
  import { loadLocalSetup, resumeSetup } from '$lib/frameleaf/first-run-setup';
</script>

<FirstRunSetup initial={resumeSetup('new', { local: loadLocalSetup('new') }, false)} authenticated={false} />
