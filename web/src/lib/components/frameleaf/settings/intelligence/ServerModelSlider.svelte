<script lang="ts">
  /**
   * The model slider of Visual search and Faces & identity: the models Frameleaf publishes for that
   * work, banded by the stored Hardware & GPU check. A saved model outside the list selects no stop
   * and is said back in `customNote`.
   */
  import ModelSlider from '$lib/components/frameleaf/cloud/ModelSlider.svelte';
  import { workerFromHardware, workerGpu } from '$lib/frameleaf/cloud-ml';
  import type { MatchedWorkload } from '$lib/frameleaf/gpu-model-catalog';
  import { getHardwareCheck, type HardwareCheckResponseDto } from '@frameleaf/sdk';
  import { onMount } from 'svelte';

  type Props = {
    workload: MatchedWorkload;
    value: string;
    label: string;
    disabled?: boolean;
    customNote?: string;
    onChange: (model: string) => void;
  };

  let { workload, value, label, disabled = false, customNote, onChange }: Props = $props();

  let hardware = $state<HardwareCheckResponseDto | null>(null);
  onMount(() => {
    void (async () => {
      try {
        hardware = await getHardwareCheck();
      } catch {
        // without a check every stop is shown as running on the processor
      }
    })();
  });

  const worker = $derived(workerFromHardware(hardware));
</script>

<div class="model-row">
  <ModelSlider
    {workload}
    {value}
    {label}
    {disabled}
    {customNote}
    gpu={workerGpu(worker, workload)}
    cpuProfile={worker.cpuProfile}
    route="both"
    onChange={(id) => onChange(id)}
  />
</div>

<style>
  /* Sits among the page's kit rows, so it takes their rule and padding. */
  .model-row {
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
</style>
