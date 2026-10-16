import type { StackResponseDto } from '@frameleaf/sdk';
import { render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import ViewerStackStrip from '$lib/components/frameleaf/ViewerStackStrip.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import en from '../../../../../i18n/en.json';

/**
 * FL-35 / VIEWER-P3: the viewer's stack card (MediaViewer.jsx:2026-2063). It names the stack and
 * shows its members, the open one marked and the primary labelled. The stack's decisions (keep this
 * and remove the rest, set as primary) are in the More menu's Stack group, never on the card.
 */

const setup = () => {
  const primary = assetFactory.build();
  const current = assetFactory.build();
  const other = assetFactory.build();
  const stack: StackResponseDto = { id: 'stack-1', primaryAssetId: primary.id, assets: [primary, current, other] };
  const onSelect = vi.fn();
  const result = render(ViewerStackStrip, { stack, asset: current, onSelect, onPreview: vi.fn() });
  return { ...result, stack, primary, current, other, onSelect };
};

describe('ViewerStackStrip', () => {
  beforeAll(() => addMessages('dev', en));

  it('is a small card named after the stack, with one tile per member', () => {
    setup();
    const card = screen.getByRole('region', { name: 'Stack · 3 items' });
    expect(card).toHaveTextContent('Stack · 3 items');
    expect(within(card).getAllByRole('listitem')).toHaveLength(3);
  });

  it('marks the open member and labels the primary', () => {
    const { container } = setup();
    const tiles = container.querySelectorAll('li');
    expect(tiles[1]).toHaveAttribute('aria-current', 'true');
    expect(tiles[0]).not.toHaveAttribute('aria-current');
    expect(tiles[0]).toHaveTextContent('Primary');
    expect(tiles[1]).not.toHaveTextContent('Primary');
  });

  it('keeps the stack decisions off the card', () => {
    setup();
    expect(screen.queryByRole('button', { name: en.keep_this_delete_others })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.frameleaf_viewer_menu_keep_this })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.set_stack_primary_asset })).not.toBeInTheDocument();
  });
});
