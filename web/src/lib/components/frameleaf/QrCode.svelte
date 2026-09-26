<script lang="ts">
  import { encodeQr, qrPath } from '$lib/frameleaf/qr';
  import { copyToClipboard } from '$lib/utils';

  const QUIET = 4;

  let {
    value,
    size = 220,
    label,
    copyLabel,
    downloadLabel,
    errorLabel,
    fileName,
    showActions = true,
  }: {
    /** The URL encoded in the code. Never a password or other secret. */
    value: string;
    size?: number;
    label: string;
    copyLabel: string;
    downloadLabel: string;
    errorLabel: string;
    fileName?: string;
    showActions?: boolean;
  } = $props();

  const encoded = $derived.by(() => {
    try {
      return { symbol: encodeQr(value, { ecc: 'M' }) };
    } catch {
      return { error: errorLabel };
    }
  });

  const safeFileName = (name: string | undefined) =>
    (name || 'frameleaf-link')
      .replaceAll(/[^\w.-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '')
      .slice(0, 60) || 'frameleaf-link';

  const downloadPng = () => {
    if (!('symbol' in encoded) || !encoded.symbol) {
      return;
    }
    const { modules } = encoded.symbol;
    const scale = 8;
    const extent = (modules.length + QUIET * 2) * scale;
    const canvas = document.createElement('canvas');
    canvas.width = extent;
    canvas.height = extent;
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, extent, extent);
    context.fillStyle = '#101112';
    for (const [y, row] of modules.entries()) {
      for (const [x, dark] of row.entries()) {
        if (dark) {
          context.fillRect((x + QUIET) * scale, (y + QUIET) * scale, scale, scale);
        }
      }
    }
    const finish = (href: string, revoke: boolean) => {
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `${safeFileName(fileName)}.png`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      if (revoke) {
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      }
    };
    canvas.toBlob((blob) => {
      if (blob) {
        finish(URL.createObjectURL(blob), true);
      } else {
        finish(canvas.toDataURL('image/png'), false);
      }
    }, 'image/png');
  };
</script>

{#if 'error' in encoded}
  <p class="qr-error" role="status">{encoded.error}</p>
{:else}
  {@const { modules } = encoded.symbol}
  {@const extent = modules.length + QUIET * 2}
  <figure class="qr">
    <svg
      class="qr-svg"
      role="img"
      aria-label={`${label} for ${value}`}
      viewBox={`0 0 ${extent} ${extent}`}
      width={size}
      height={size}
      shape-rendering="crispEdges"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={qrPath(modules, QUIET)} fill="#101112" />
    </svg>
    {#if showActions}
      <figcaption class="qr-actions">
        <button type="button" onclick={() => copyToClipboard(value)}>{copyLabel}</button>
        <button type="button" onclick={downloadPng}>{downloadLabel}</button>
      </figcaption>
    {/if}
  </figure>
{/if}

<style>
  .qr {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    margin: 0;
  }
  .qr-svg {
    background: #ffffff;
    border-radius: var(--fl-radius);
    padding: 0.5rem;
  }
  .qr-actions {
    display: flex;
    gap: 0.5rem;
  }
  .qr-actions button {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0 0.75rem;
  }
  .qr-error {
    color: var(--fl-muted);
  }
</style>
