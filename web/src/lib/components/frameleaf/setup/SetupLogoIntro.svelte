<script lang="ts">
  /** The Frameleaf symbol draws its outline, fills, then the wordmark and `[data-intro]` children rise. */
  import logoDarkUrl from '$lib/assets/frameleaf/frameleaf-logo-dark.svg?url';
  import { logoIntro } from '$lib/components/frameleaf/setup/setup-motion';
  import type { Snippet } from 'svelte';

  const { onSettled, children }: { onSettled?: () => void; children?: Snippet } = $props();

  const FRAME =
    'M 67 2 H 171 C 207 2 236 31 236 67 V 172 C 236 208 207 237 171 237 H 130 C 145 230 158 219 169 205 C 190 202 205 189 205 168 V 71 C 205 50 188 34 167 34 H 72 C 51 34 34 51 34 72 V 166 C 34 182 37 192 47 200 L 48 235 C 21 228 2 203 2 171 V 68 C 2 31 30 2 67 2 Z';
  const LEAF =
    'M 174 102 C 147 102 128 101 112 106 C 89 112 72 124 61 140 C 49 157 45 177 46 200 L 48 235 C 60 201 83 172 119 147 C 94 173 77 202 66 239 C 101 239 128 229 149 208 C 169 188 175 159 174 129 Z';
</script>

<div class="frs-logo" use:logoIntro={onSettled}>
  <div class="frs-logo-mark">
    <span class="frs-logo-glow" aria-hidden="true"></span>
    <svg viewBox="-6 -6 268 268" role="img" aria-label="Frameleaf">
      <defs>
        <linearGradient id="frs-frame" gradientUnits="userSpaceOnUse" x1="15" y1="8" x2="226" y2="237">
          <stop offset="0" stop-color="#86f345" />
          <stop offset="0.25" stop-color="#36ec72" />
          <stop offset="0.57" stop-color="#00c4d6" />
          <stop offset="0.76" stop-color="#00c7b0" />
          <stop offset="1" stop-color="#00d874" />
        </linearGradient>
        <linearGradient id="frs-leaf" gradientUnits="userSpaceOnUse" x1="103" y1="101" x2="136" y2="240">
          <stop offset="0" stop-color="#56f260" />
          <stop offset="0.5" stop-color="#21de73" />
          <stop offset="1" stop-color="#00bc9e" />
        </linearGradient>
      </defs>
      <path class="frs-logo-fill" d={FRAME} fill="url(#frs-frame)" />
      <path class="frs-logo-fill" d={LEAF} fill="url(#frs-leaf)" />
      <circle class="frs-logo-fill" cx="172.5" cy="66.5" r="16.5" fill="url(#frs-frame)" />
      <path class="frs-logo-stroke" d={FRAME} pathLength="1" />
      <path class="frs-logo-stroke" d={LEAF} pathLength="1" />
    </svg>
  </div>
  <!-- Wordmark only: the lockup's own icon is cropped away so the symbol shows once. -->
  <span data-intro class="frs-wordmark" role="img" aria-label="Frameleaf"><img src={logoDarkUrl} alt="" /></span>
  {@render children?.()}
</div>
