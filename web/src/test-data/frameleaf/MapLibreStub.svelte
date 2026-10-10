<script lang="ts">
  import { getMapLibreStubMap, setMapLibreStubProps } from './map-libre-stub';

  interface Props {
    map?: unknown;
    onload?: (map: unknown) => void;
    onerror?: (event: { error?: unknown; sourceId?: string }) => void;
    onmoveend?: (event: unknown) => void;
  }

  // A `$bindable` default would throw for the consumer's `bind:map` of an undefined state, so the fake
  // map instance a spec hands in (to move the view) is assigned instead; eslint cannot see bind:map.
  // eslint-disable-next-line no-useless-assignment
  let { map = $bindable(undefined), onload, onerror, onmoveend }: Props = $props();
  // eslint-disable-next-line no-useless-assignment
  map = getMapLibreStubMap();

  // Recorded as soon as this stands in for `<MapLibre>`, mirroring the real component attaching
  // its `error` and `moveend` listeners synchronously when the map instance is created (before any
  // style request resolves) rather than only after `load`.
  setMapLibreStubProps({ onload, onerror, onmoveend });
</script>

<div aria-label="Map"></div>
