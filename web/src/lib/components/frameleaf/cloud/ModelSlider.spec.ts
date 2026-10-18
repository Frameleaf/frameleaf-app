import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { gpuProfileFor, ladderFor } from '$lib/frameleaf/gpu-model-catalog';
import en from '../../../../../../i18n/en.json';
import ModelSlider from './ModelSlider.svelte';

const rtx4090 = {
  name: 'NVIDIA GeForce RTX 4090',
  vramGb: 24,
  backend: 'CUDA',
  profile: gpuProfileFor('RTX 4090', 24),
};

describe('ModelSlider (FL-159 §3.3)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  it('is a radio group with one stop per model, each named with where it runs, not by colour alone', () => {
    render(ModelSlider, {
      workload: 'descriptions',
      value: 'qwen3.5-9b@1',
      gpu: rtx4090,
      route: 'both',
      label: 'Descriptions',
    });

    const group = screen.getByRole('group', { name: 'Descriptions' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(ladderFor('descriptions').length);
    expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(1);
    for (const radio of radios) {
      expect(radio.closest('label')?.textContent).toMatch(/\S+: \S+/);
    }
  });

  it('with this server only, keeps cloud-only models visible but unavailable, with the reason', () => {
    render(ModelSlider, { workload: 'restoration', value: undefined, gpu: null, route: 'local', label: 'Restoration' });

    const radios = within(screen.getByRole('group', { name: 'Restoration' })).getAllByRole('radio');
    const disabled = radios.filter((radio) => (radio as HTMLInputElement).disabled);
    expect(disabled.length).toBeGreaterThan(0);
    for (const radio of disabled) {
      expect(radio.getAttribute('aria-describedby')).toBeTruthy();
    }
  });

  it('reports the chosen model', async () => {
    const onChange = vi.fn();
    render(ModelSlider, {
      workload: 'descriptions',
      value: 'qwen3.5-9b@1',
      gpu: rtx4090,
      route: 'both',
      label: 'Descriptions',
      onChange,
    });

    const radios = within(screen.getByRole('group', { name: 'Descriptions' })).getAllByRole('radio');
    const other = radios.find(
      (radio) => !(radio as HTMLInputElement).checked && !(radio as HTMLInputElement).disabled,
    )!;
    await fireEvent.click(other);
    expect(onChange).toHaveBeenCalledWith(
      (other as HTMLInputElement).value,
      expect.objectContaining({ disabled: false }),
    );
  });

  it("shows the smart search and faces blue stop only while Frameleaf Cloud offers this server's model (FL-455)", () => {
    const { unmount } = render(ModelSlider, {
      workload: 'search',
      value: 'ViT-B-16-SigLIP-384__webli',
      gpu: rtx4090,
      route: 'both',
      label: 'Smart search',
    });
    let group = screen.getByRole('group', { name: 'Smart search' });
    expect(group.querySelectorAll('.ms-stop.is-cloud')).toHaveLength(0);
    expect(within(group).queryByText(/Frameleaf Cloud only/)).not.toBeInTheDocument();
    unmount();

    render(ModelSlider, {
      workload: 'faces',
      value: 'buffalo_l',
      gpu: rtx4090,
      route: 'both',
      label: 'Face recognition',
      cloudMatched: ['face'],
    });
    group = screen.getByRole('group', { name: 'Face recognition' });
    const blue = group.querySelectorAll('.ms-stop.is-cloud');
    expect(blue).toHaveLength(1);
    expect(blue[0].querySelector('input')?.value).toBe('buffalo_l@cloud');
    expect(within(group).getByRole('radio', { name: /^buffalo_l: Cloud · about/ })).toBeEnabled();
    expect(within(group).getByText(/Frameleaf Cloud only/)).toBeInTheDocument();
  });
});
