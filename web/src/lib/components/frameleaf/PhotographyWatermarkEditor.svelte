<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Button from './Button.svelte';
  import { watermarkPreview, type Watermark } from '$lib/frameleaf/photography/workflow-api';
  import { loadLogos } from '$lib/frameleaf/photography/api';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';

  let { value = $bindable(), disabled = false }: { value: Watermark; disabled?: boolean } = $props();
  let orientation = $state<'portrait' | 'landscape'>('landscape');
  let background = $state<'light' | 'dark'>('dark');
  let preview = $state('');
  let error = $state('');
  let rendering = $state(false);
  let logos = $state<{ id: string; fileName: string }[]>([]);
  let cursor = $state<string | null>(null);
  let generation = 0;
  let disposed = false;
  const failure = (cause: unknown) => (cause instanceof Error ? cause.message : 'The preview could not be prepared.');

  async function refresh() {
    const current = ++generation;
    rendering = true;
    error = '';
    // Never retain an old mark while a new preview is being prepared.
    if (preview) {
      URL.revokeObjectURL(preview);
    }
    preview = '';
    try {
      const blob = await watermarkPreview($state.snapshot(value), orientation, background);
      if (disposed || current !== generation) {
        return;
      }
      preview = URL.createObjectURL(blob);
    } catch (error_) {
      if (!disposed && current === generation) {
        error = failure(error_);
      }
    } finally {
      if (current === generation) {
        rendering = false;
      }
    }
  }
  async function moreLogos() {
    try {
      const page = await loadLogos(cursor);
      if (disposed) {
        return;
      }
      logos = [...logos, ...page.logos.filter((logo) => logos.every((old) => old.id !== logo.id))];
      cursor = page.nextCursor;
    } catch (error_) {
      error = failure(error_);
    }
  }
  async function uploadLogo() {
    try {
      const [id] = await openFileUploadDialog({ multiple: false });
      if (!disposed && id) {
        value.logoAssetId = id;
        value.type = 'both';
        await refresh();
      }
    } catch (error_) {
      error = failure(error_);
    }
  }
  onMount(() => {
    void moreLogos();
    void refresh();
  });
  onDestroy(() => {
    disposed = true;
    generation++;
    if (preview) {
      URL.revokeObjectURL(preview);
    }
  });
</script>

<div class="phd-watermark-editor">
  <fieldset {disabled}>
    <legend>Watermark composition</legend>
    <div class="phd-fields">
      <label
        >Content<select bind:value={value.type}
          ><option value="text">Studio text</option><option value="logo">Uploaded logo</option><option value="both"
            >Logo and studio text</option
          ></select
        ></label
      >
      <label>Studio name<input maxlength="200" required bind:value={value.text} /></label>
      <label>Second line<input maxlength="200" bind:value={value.secondLine} placeholder="PROOF" /></label>
      <label
        >Font<select bind:value={value.font}
          ><option value="script">Wedding script</option><option value="serif">Serif</option><option value="sans"
            >Sans serif</option
          ></select
        ></label
      >
      <label
        >Logo<select bind:value={value.logoAssetId}
          ><option value={null}>Choose a logo</option>{#each logos as logo (logo.id)}<option value={logo.id}
              >{logo.fileName}</option
            >{/each}</select
        ></label
      >
      <label
        >Logo variant<select bind:value={value.logoVariant}
          ><option value="original">Original colours</option><option value="light">Light</option><option value="dark"
            >Dark</option
          ></select
        ></label
      >
      <label
        >Logo placement<select bind:value={value.logoPosition}
          >{#each ['above', 'below', 'left', 'right'] as position (position)}<option>{position}</option>{/each}</select
        ></label
      >
      <label
        >Alignment<select bind:value={value.alignment}
          >{#each ['left', 'center', 'right'] as alignment (alignment)}<option>{alignment}</option>{/each}</select
        ></label
      >
    </div>
    <div class="phd-actions">
      <Button onclick={uploadLogo}>Upload logo</Button>{#if cursor}<Button onclick={moreLogos}>More logos</Button>{/if}
    </div>
    <div class="phd-fields">
      <label
        >Pattern<select bind:value={value.pattern}
          ><option value="signature">Web signature</option><option value="centre">Centre mark</option><option
            value="diagonal">Diagonal band</option
          ><option value="tile">Repeated proof pattern</option></select
        ></label
      >
      <label
        >Position<select bind:value={value.position}
          >{#each ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center'] as position (position)}<option
              >{position}</option
            >{/each}</select
        ></label
      >
      <label>Colour<input type="color" bind:value={value.color} /></label>
      <label>Size · {value.size}%<input type="range" min="1" max="30" bind:value={value.size} /></label>
      <label
        >Logo scale · {value.logoScale}<input
          type="range"
          min="0.25"
          max="4"
          step="0.25"
          bind:value={value.logoScale}
        /></label
      >
      <label>Opacity · {value.opacity}%<input type="range" min="1" max="100" bind:value={value.opacity} /></label>
      <label>Rotation · {value.rotation}°<input type="range" min="-180" max="180" bind:value={value.rotation} /></label>
      <label>Margin · {value.margin}%<input type="range" min="0" max="25" bind:value={value.margin} /></label>
      <label>Repeat spacing · {value.spacing}%<input type="range" min="0" max="100" bind:value={value.spacing} /></label
      >
    </div>
    <div class="phd-actions">
      <label><input type="checkbox" bind:checked={value.outline} />Text outline</label><label
        ><input type="checkbox" bind:checked={value.backing} />Contrast backing</label
      >
    </div>
  </fieldset>
  <section class="phd-preview" aria-label="Rendered watermark preview">
    <div class="phd-actions">
      <label
        >Preview shape<select bind:value={orientation}
          ><option value="landscape">Landscape</option><option value="portrait">Portrait</option></select
        ></label
      >
      <label
        >Test canvas<select bind:value={background}
          ><option value="dark">Dark</option><option value="light">Light</option></select
        ></label
      >
      <Button disabled={disabled || rendering} onclick={refresh}>{rendering ? 'Rendering…' : 'Refresh preview'}</Button>
    </div>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if preview}<img
        src={preview}
        alt="Studio watermark rendered into the test canvas"
        class:portrait={orientation === 'portrait'}
      />{:else}<p role="status">
        {rendering ? 'Preparing preview…' : 'Refresh the preview to see your watermark.'}
      </p>{/if}
  </section>
</div>
