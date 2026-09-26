<script lang="ts">
  import { setMapLibreStubProps } from './map-libre-stub';

  interface Props {
    map?: unknown;
    onload?: (map: unknown) => void;
    onerror?: (event: { error?: unknown; sourceId?: string }) => void;
  }

  // `map` is accepted only so `bind:map` on the real `<MapLibre>` keeps compiling against this stub;
  // no test needs its value.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let { map = $bindable(undefined), onload, onerror }: Props = $props();

  // Recorded as soon as this stands in for `<MapLibre>`, mirroring the real component attaching
  // its `error` listener synchronously when the map instance is created (before any style request
  // resolves) rather than only after `load`.
  setMapLibreStubProps({ onload, onerror });
</script>

<div aria-label="Map"></div>
