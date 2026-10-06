import {
  MachineLearningHardwareAcceleration,
  type AdminConfigImageDescriptionDto,
  type AdminConfigMachineLearningDto,
  type AdminConfigNsfwDetectionDto,
  type EnrichmentOptionsResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import ImageDescriptionSection from './ImageDescriptionSection.svelte';

const description = (videoMomentCaptions: boolean) =>
  ({
    enabled: true,
    acceleration: MachineLearningHardwareAcceleration.Auto,
    modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
    fallbackModelName: 'microsoft/Florence-2-base-ft',
    device: 'AUTO',
    videoMomentCaptions,
    prompt: {
      style: 'balanced',
      sentenceCountTarget: 3,
      lookFor: [],
      customVocabulary: [],
      customInstructions: '',
      nsfwIndicators: [],
      medicalIndicators: [],
      forbiddenInferences: [],
      identityInjection: { enabled: true, maxNames: 5, minFaceConfidence: 0.7 },
      advanced: { enabled: false, rawPromptTemplate: '', placeholderValidation: 'strict' },
    },
    pendingRequeueAt: null,
    lastConfigChangeAt: null,
  }) as AdminConfigImageDescriptionDto;

const renderSection = async (imageDescription: AdminConfigImageDescriptionDto) => {
  render(ImageDescriptionSection, {
    workingConfig: { enabled: true } as AdminConfigMachineLearningDto,
    imageDescription,
    savedImageDescription: description(false),
    nsfwDetection: { enabled: false } as AdminConfigNsfwDetectionDto,
    detectedAcceleration: undefined,
    isMachineLearningConfigEdited: false,
    disabled: false,
  });
  // the section is a collapsed group until it is opened
  await fireEvent.click(screen.getAllByRole('button', { expanded: false })[0]);
};

describe('Descriptions & tags: video moments (FL-59, settings-catalog.mjs:479-493, 1990-2003)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    sdkMock.getImageDescriptionRequeueEstimate.mockResolvedValue({
      totalAssets: 0,
      withDescription: 0,
      withoutDescription: 0,
      estimatedTotalSeconds: 0,
    } as never);
    sdkMock.getEnrichmentOptions.mockResolvedValue({ framesPerVideo: 6 } as EnrichmentOptionsResponseDto);
  });

  it('turns Describe video moments on in the draft, off by default', async () => {
    const imageDescription = description(false);
    await renderSection(imageDescription);

    const toggle = await screen.findByRole('switch', { name: /Describe video moments/ });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Adds captions to key moments in videos; check a few videos first.')).toBeInTheDocument();

    await fireEvent.click(toggle);
    expect(imageDescription.videoMomentCaptions).toBe(true);
  });

  it('shows the frames per video fixed by the server’s sampling policy, not editable', async () => {
    await renderSection(description(false));

    const frames = await screen.findByLabelText('Frames looked at per video');
    await vi.waitFor(() => expect(frames).toHaveValue(6));
    expect(frames).toBeDisabled();
    expect(screen.getByText('Current sampling policy')).toBeInTheDocument();
  });
});
