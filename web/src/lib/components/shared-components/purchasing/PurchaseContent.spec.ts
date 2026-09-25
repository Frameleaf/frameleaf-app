import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../../../i18n/en.json';
import PurchaseContent from './PurchaseContent.svelte';

vi.mock('$lib/utils/license-utils', () => ({
  activateProduct: vi.fn(),
  getActivationKey: vi.fn(),
  getLicenseLink: (product: string) => `https://store.example.test/?productId=${product}`,
}));

const messages = en as Record<string, unknown>;

// FL-146 owner decision (2026-09-25): buying and supporter copy says "Support Frameleaf"; supporting
// with a product key gives access to Frameleaf Cloud. Customer copy never names Immich as the
// product, never mentions a GPU provider, and never says "fork" or "DTO".
const supportKeys = Object.keys(messages).filter(
  (key) =>
    key === 'buy' ||
    key === 'supporter' ||
    key.startsWith('purchase_') ||
    key.startsWith('user_purchase_settings') ||
    key.includes('supporter') ||
    key.startsWith('frameleaf_access_server_key'),
);

describe('Support Frameleaf wording (FL-157)', () => {
  beforeEach(() => {
    addMessages('dev', en);
  });

  it('names Frameleaf, not the inherited product, on every buy and supporter string', () => {
    expect(supportKeys.length).toBeGreaterThan(40);
    for (const key of supportKeys) {
      const value = String(messages[key]);
      expect(value, key).not.toMatch(/immich|\bfork\b|\bdto\b|nvidia|cuda|runpod|gpu/i);
    }
    expect(messages.buy).toBe('Support Frameleaf');
  });

  it('shows the prototype heading, the Frameleaf Cloud benefit and the key entry', () => {
    render(PurchaseContent, { onActivate: vi.fn() });

    expect(screen.getByRole('heading', { name: 'Support Frameleaf' })).toBeInTheDocument();
    expect(
      screen.getByText(/access to Frameleaf Cloud, enhanced machine learning features and more/),
    ).toBeInTheDocument();
    expect(screen.getByText('Already have a key?')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Purchase' })).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/immich/i);
  });
});
