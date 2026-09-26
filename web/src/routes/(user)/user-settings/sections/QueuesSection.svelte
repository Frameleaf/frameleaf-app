<script lang="ts">
  /**
   * Compute & jobs → Queues & jobs (FL-71): the template's Job manager (`JobsManager.jsx`) on the
   * server's queues, with one queue opening inside the section (`?queue=<slug>&tab=<state>`). The old
   * `/admin/queues` addresses only redirect here. The section carries its own heading, as in the template.
   */
  import JobsManager from '$lib/components/frameleaf/JobsManager.svelte';
</script>

<JobsManager />
