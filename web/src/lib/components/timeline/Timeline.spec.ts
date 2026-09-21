import { waitFor } from '@testing-library/svelte';
import { AssetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import Timeline from './Timeline.svelte';

// A privacy-gated timeline can mount after the navigation event has completed.
vi.mock('$app/navigation', () => ({
  afterNavigate: vi.fn(),
  beforeNavigate: vi.fn(),
  goto: vi.fn(),
  onNavigate: vi.fn(),
}));

vi.mock('$lib/elements/HotModuleReload.svelte', async () => {
  const { default: MockText } = await import('@test-data/components/MockText.svelte');
  return { default: MockText };
});

describe('Timeline delayed mounting', () => {
  it('reveals a routed timeline without waiting for another navigation', async () => {
    const { container } = renderWithTooltips(Timeline, {
      enableRouting: true,
      assetInteraction: new AssetMultiSelectManager(),
    });
    await waitFor(() => expect(container.querySelector('#virtual-timeline')).not.toHaveClass('invisible'));
  });
});
