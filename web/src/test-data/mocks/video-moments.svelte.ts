/**
 * How many videos the stand-in moments strip (VideoMomentResults.mock.svelte) reports, set by the spec; undefined
 * while its moments are still on their way.
 */
export const moments = $state<{ found: number | undefined }>({ found: 0 });
