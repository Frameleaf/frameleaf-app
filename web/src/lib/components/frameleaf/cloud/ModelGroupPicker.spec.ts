import { CloudMlModelGroup, MlWorkload, type CloudMlModelDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import ModelGroupPicker from './ModelGroupPicker.svelte';

const entry = (id: string, modelName: string, rank: number, isDefault = false): CloudMlModelDto => ({
  id,
  workload: MlWorkload.Enrichment,
  group: CloudMlModelGroup.Descriptions,
  name: `Descriptions · ${modelName}`,
  modelName,
  localModel: null,
  description: `${modelName}, L40S-class`,
  fingerprint: 'mr_1',
  pricingUnit: 'second',
  priceUsd: 0.002,
  rank,
  isDefault,
});

const props = (models: CloudMlModelDto[], extra = {}) => ({
  group: CloudMlModelGroup.Descriptions,
  legend: 'Caption model',
  name: 'Descriptions',
  models,
  modelId: null,
  onSaved: vi.fn(),
  ...extra,
});

describe('ModelGroupPicker', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('puts the quality word above each stop, the model name on the stop and the word first in the readout', () => {
    render(
      ModelGroupPicker,
      props([entry('m1', 'Qwen 2B', 1, true), entry('m2', 'Qwen 9B', 2), entry('m3', 'Qwen 27B', 3)]),
    );

    const group = screen.getByRole('group', { name: 'Caption model' });
    expect([...group.querySelectorAll('.ms-tier')].map((tier) => tier.textContent)).toEqual(['Good', 'Better', 'Best']);
    expect([...group.querySelectorAll('.ms-stop-name')].map((stop) => stop.textContent?.trim())).toEqual([
      'Qwen 2B',
      'Qwen 9B',
      'Qwen 27B',
    ]);
    expect(group.querySelector(':scope .ms-readout strong')?.textContent).toBe('Good · Qwen 2B');
    expect(within(group).getByText('Faster')).toBeInTheDocument();
  });

  it('shows a single published model as a plain row saying where it runs', () => {
    render(ModelGroupPicker, props([entry('m1', 'RIFE', 1, true)]));

    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('Caption model')).toBeInTheDocument();
    expect(screen.getByText('RIFE. Frameleaf Cloud.')).toBeInTheDocument();
    expect(screen.getByText('Frameleaf Cloud')).toBeInTheDocument();
  });

  it('lets a single model with no default be chosen, so its jobs are not refused', async () => {
    sdkMock.setCloudMlModelChoice.mockResolvedValue({ choices: [] });
    const voice = { ...entry('m1', 'Kokoro', 1), group: CloudMlModelGroup.Tts, workload: MlWorkload.StudioAi };
    render(ModelGroupPicker, props([voice], { group: CloudMlModelGroup.Tts }));

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_model_only_use }));
    await vi.waitFor(() =>
      expect(sdkMock.setCloudMlModelChoice).toHaveBeenCalledWith({
        group: CloudMlModelGroup.Tts,
        cloudMlModelChoiceUpdateDto: { modelId: 'm1' },
      }),
    );
  });

  it('shows one blue stop that names no model until the server is linked, and sets Cloud up when picked', async () => {
    const onNeedsCloud = vi.fn();
    render(ModelGroupPicker, { ...props([]), models: null, cloudPlaceholder: true, onNeedsCloud });

    const radio = screen.getByRole('radio', { name: /Frameleaf Cloud|frameleaf_enhance_model_cloud/ });
    await fireEvent.click(radio);

    expect(onNeedsCloud).toHaveBeenCalledTimes(1);
    expect(sdkMock.setCloudMlModelChoice).not.toHaveBeenCalled();
    expect(radio).not.toBeChecked();
  });

  it('offers blue stops when Frameleaf Cloud is not set up, and says so when one is picked', async () => {
    const onNeedsCloud = vi.fn();
    sdkMock.setCloudMlModelChoice.mockResolvedValue({ choices: [] });
    render(
      ModelGroupPicker,
      props([entry('m1', 'Qwen 2B', 1, true), entry('m2', 'Qwen 9B', 2)], {
        cloudSetUp: false,
        onNeedsCloud,
      }),
    );

    const radio = screen.getByRole('radio', { name: /Qwen 9B/ });
    expect(radio).toBeEnabled();
    await fireEvent.click(radio);
    expect(onNeedsCloud).toHaveBeenCalledTimes(1);
  });
});
