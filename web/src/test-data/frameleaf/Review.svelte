<script lang="ts">
  import { TooltipProvider } from '@immich/ui';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import Brand from '$lib/components/frameleaf/Brand.svelte';
  import Rail from '$lib/components/frameleaf/Rail.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import FilterChip from '$lib/components/frameleaf/FilterChip.svelte';
  import TreeBranch from '$lib/components/frameleaf/TreeBranch.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import Picker from '$lib/components/frameleaf/Picker.svelte';
  import PickerHarness from './PickerHarness.svelte';
  import DialogHarness from './DialogHarness.svelte';
  import ControlsHarness from './ControlsHarness.svelte';
  import MenuHarness from './MenuHarness.svelte';
  let theme: 'dark' | 'light' = $state('dark');
  let collapsed = $state(false);
  let chip = $state(true);
</script>

<TooltipProvider>
  <Theme {theme}>
    <main>
      <Brand />
      <h1>Frameleaf primitive review</h1>
      <button type="button" onclick={() => (theme = theme === 'dark' ? 'light' : 'dark')}>Change theme</button>
      <PickerHarness {theme} />
      <PickerHarness {theme} disabled />
      <ControlsHarness {theme} />
      <ControlsHarness {theme} disabled />
      <MenuHarness {theme} />
      <div class="workspace">
        <Rail label="Library" toggleLabel="Toggle navigation" bind:collapsed>
          {#snippet children(isCollapsed)}
            <a href="#library" aria-label="Library">{isCollapsed ? 'L' : 'Library'}</a>
          {/snippet}
        </Rail>
        <Pane label="Library filters">
          <TreeBranch label="Collections"><a href="#album">Album</a></TreeBranch>
          {#if chip}<FilterChip label="2026" removeLabel="Remove year 2026" onRemove={() => (chip = false)} />{/if}
          <Picker
            label="Camera"
            options={[
              { label: 'Camera A (12)', value: 'a' },
              { label: 'Camera B (8)', value: 'b' },
            ]}
          />
          <DialogHarness />
          <Status message="All changes saved" />
        </Pane>
      </div>
    </main>
  </Theme>
</TooltipProvider>

<style>
  main {
    min-height: 100dvh;
    padding: 1rem;
  }
  .workspace {
    display: flex;
    gap: 1rem;
    margin-top: 1rem;
    flex-wrap: wrap;
  }
  a {
    display: inline-block;
    min-height: 44px;
    align-content: center;
  }
  button {
    padding: 0.5rem;
  }
</style>
