import {
  CloudMlConnection,
  MlDestinationKind,
  MlWorkload,
  type CloudMlStatusResponseDto,
  type MlDestinationResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../../i18n/en.json';
import ServerModelSlider from './ServerModelSlider.svelte';

const CLOUD = 'cloud-destination';

const destination = (id: string, kind: MlDestinationKind, enabled = true) =>
  ({
    id,
    kind,
    enabled,
    workloads: [MlWorkload.Clip, MlWorkload.Face],
    consent: { required: false, acknowledgedAt: null },
    role: 'library-analysis',
  }) as unknown as MlDestinationResponseDto;

const twin = {
  id: 'ms_C11P0000',
  workload: MlWorkload.Clip,
  group: null,
  name: 'Search · Standard',
  modelName: 'SigLIP ViT-B/16-384',
  localModel: 'ViT-B-16-SigLIP-384__webli',
  description: 'SigLIP ViT-B/16-384, 24 GB',
  fingerprint: 'mr_1',
  pricingUnit: 'second',
  priceUsd: 0.001,
  rank: 1,
  isDefault: true,
};

const readyStatus = {
  connection: CloudMlConnection.Ready,
  enabled: true,
  consent: { acceptedVersion: '1', outdated: false, features: { smartSearch: true, faceRecognition: true } },
} as unknown as CloudMlStatusResponseDto;

type Route = { workload: MlWorkload; destinationId: string | null; followsOrder?: boolean };

const setup = ({
  routed = false,
  cloudReady = true,
  status = readyStatus,
  route,
}: {
  routed?: boolean;
  cloudReady?: boolean;
  status?: CloudMlStatusResponseDto;
  route?: Route;
} = {}) => {
  sdkMock.getHardwareCheck.mockResolvedValue(undefined as never);
  sdkMock.getCloudMlStatus.mockResolvedValue(status);
  sdkMock.getCloudMlCatalog.mockResolvedValue({ models: [twin] });
  sdkMock.getCloudMlModelChoices.mockResolvedValue({ choices: [] });
  sdkMock.listMlDestinations.mockResolvedValue([
    destination('home', MlDestinationKind.Local),
    ...(cloudReady ? [destination(CLOUD, MlDestinationKind.FrameleafCloud)] : []),
  ]);
  sdkMock.getMlWorkloadRoutes.mockResolvedValue({
    routes: route ? [route] : routed ? [{ workload: MlWorkload.Clip, destinationId: CLOUD, modelId: null }] : [],
  } as never);
  sdkMock.setMlWorkloadRoute.mockResolvedValue({
    routes: [{ workload: MlWorkload.Clip, destinationId: CLOUD, followsOrder: false, modelId: null }],
  } as never);
  // Following the order takes the work off Frameleaf Cloud, unless a test says the order still leads there.
  sdkMock.setMlWorkloadProcessingOrder.mockImplementation(() => {
    sdkMock.getMlWorkloadRoutes.mockResolvedValue({ routes: [] } as never);
    return Promise.resolve({} as never);
  });
};

describe('ServerModelSlider', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderSlider = async (value: string, onChange = vi.fn(), onNeedsCloud = vi.fn()) => {
    const { rerender } = render(ServerModelSlider, {
      workload: 'search',
      value,
      saved: value,
      label: 'Search quality',
      onChange,
      onNeedsCloud,
    });
    return { rerender, onChange, onNeedsCloud, blue: await screen.findByRole('radio', { name: /Frameleaf Cloud/ }) };
  };

  const LOCAL = 'ViT-B-32__openai';
  const BLUE = 'ViT-B-16-SigLIP-384__webli';
  const movedToCloud = async (rendered: Awaited<ReturnType<typeof renderSlider>>) => {
    await fireEvent.click(rendered.blue);
    await vi.waitFor(() => expect(rendered.onChange).toHaveBeenCalledWith(BLUE));
    await rendered.rerender({ value: BLUE });
    sdkMock.setMlWorkloadRoute.mockClear();
    sdkMock.setMlWorkloadProcessingOrder.mockClear();
  };

  it('offers a blue stop only for a model the catalogue lists', async () => {
    setup();
    await renderSlider('ViT-B-32__openai');

    expect(screen.getAllByRole('radio', { name: /Frameleaf Cloud/ })).toHaveLength(1);
  });

  it('picking a blue stop sets the local model it runs and routes the work to Frameleaf Cloud', async () => {
    setup();
    const { onChange, blue } = await renderSlider('ViT-B-32__openai');

    await fireEvent.click(blue);

    await vi.waitFor(() =>
      expect(sdkMock.setMlWorkloadRoute).toHaveBeenCalledWith({
        workload: MlWorkload.Clip,
        mlWorkloadRouteUpdateDto: { destinationId: CLOUD },
      }),
    );
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('ViT-B-16-SigLIP-384__webli'));
    expect(onChange).not.toHaveBeenCalledWith(expect.stringContaining('@cloud'));
  });

  it('a same-model move to Cloud changes the route and not the model', async () => {
    setup();
    const { onChange, blue } = await renderSlider('ViT-B-16-SigLIP-384__webli');

    await fireEvent.click(blue);

    await vi.waitFor(() => expect(sdkMock.setMlWorkloadRoute).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picking a local stop while routed to Cloud moves the work back', async () => {
    setup({ routed: true });
    const { blue } = await renderSlider('ViT-B-16-SigLIP-384__webli');
    expect(blue).toBeChecked();

    await fireEvent.click(screen.getByRole('radio', { name: /CLIP ViT-B-32/ }));

    await vi.waitFor(() =>
      expect(sdkMock.setMlWorkloadProcessingOrder).toHaveBeenCalledWith({
        workload: MlWorkload.Clip,
        mlWorkloadProcessingOrderUpdateDto: { sources: null },
      }),
    );
    expect(sdkMock.setMlWorkloadRoute).not.toHaveBeenCalled();
  });

  it('pins a local stop to this server when the main order would still send it to Cloud', async () => {
    setup({ routed: true });
    // the order puts Frameleaf Cloud first: following it leaves the work there
    sdkMock.setMlWorkloadProcessingOrder.mockResolvedValue({} as never);
    await renderSlider(BLUE);

    await fireEvent.click(screen.getByRole('radio', { name: /CLIP ViT-B-32/ }));

    await vi.waitFor(() =>
      expect(sdkMock.setMlWorkloadRoute).toHaveBeenCalledWith({
        workload: MlWorkload.Clip,
        mlWorkloadRouteUpdateDto: { destinationId: 'home' },
      }),
    );
  });

  it('Discard puts the route back with the model, once', async () => {
    setup();
    const rendered = await renderSlider(LOCAL);
    await movedToCloud(rendered);

    await rendered.rerender({ value: LOCAL });

    await vi.waitFor(() => expect(sdkMock.setMlWorkloadProcessingOrder).toHaveBeenCalledTimes(1));
    expect(sdkMock.setMlWorkloadProcessingOrder).toHaveBeenCalledWith({
      workload: MlWorkload.Clip,
      mlWorkloadProcessingOrderUpdateDto: { sources: null },
    });
    await rendered.rerender({ value: LOCAL });
    expect(sdkMock.setMlWorkloadProcessingOrder).toHaveBeenCalledTimes(1);
  });

  it('saving leaves the route where it was put', async () => {
    setup();
    const rendered = await renderSlider(LOCAL);
    await movedToCloud(rendered);

    await rendered.rerender({ saved: BLUE });
    await rendered.rerender({ value: BLUE });

    expect(sdkMock.setMlWorkloadRoute).not.toHaveBeenCalled();
    expect(sdkMock.setMlWorkloadProcessingOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['a computer', 'home'],
    ['Nowhere', null],
  ])('Undo keeps a row pinned to %s pinned there', async (_name, destinationId) => {
    setup({ route: { workload: MlWorkload.Clip, destinationId, followsOrder: false } });
    const rendered = await renderSlider(LOCAL);
    await movedToCloud(rendered);

    await rendered.rerender({ value: LOCAL });

    await vi.waitFor(() =>
      expect(sdkMock.setMlWorkloadRoute).toHaveBeenCalledWith({
        workload: MlWorkload.Clip,
        mlWorkloadRouteUpdateDto: { destinationId },
      }),
    );
    expect(sdkMock.setMlWorkloadProcessingOrder).not.toHaveBeenCalled();
  });

  it('writes nothing for a blue stop until set-up finishes, and nothing at all on Not now', async () => {
    setup({ status: { ...readyStatus, enabled: false } });
    const { onChange, onNeedsCloud, blue } = await renderSlider(LOCAL);

    await fireEvent.click(blue);

    await vi.waitFor(() => expect(onNeedsCloud).toHaveBeenCalledTimes(1));
    expect(sdkMock.setMlWorkloadRoute).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    sdkMock.getCloudMlStatus.mockResolvedValue(readyStatus);
    onNeedsCloud.mock.calls[0][0].onDone();

    await vi.waitFor(() =>
      expect(sdkMock.setMlWorkloadRoute).toHaveBeenCalledWith({
        workload: MlWorkload.Clip,
        mlWorkloadRouteUpdateDto: { destinationId: CLOUD },
      }),
    );
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(BLUE));
  });

  it('asks again for Search consent when Cloud is on without it', async () => {
    setup({
      status: {
        ...readyStatus,
        consent: { acceptedVersion: '1', outdated: false, features: { faceRecognition: true } },
      } as CloudMlStatusResponseDto,
    });
    const { onNeedsCloud, blue } = await renderSlider(LOCAL);

    await fireEvent.click(blue);

    await vi.waitFor(() =>
      expect(onNeedsCloud).toHaveBeenCalledWith(expect.objectContaining({ consentFeature: 'smartSearch' })),
    );
    expect(sdkMock.setMlWorkloadRoute).not.toHaveBeenCalled();
  });

  it('asks for Frameleaf Cloud to be set up, and changes nothing, when it cannot take the work', async () => {
    setup({ cloudReady: false });
    const { onChange, onNeedsCloud, blue } = await renderSlider('ViT-B-32__openai');

    await fireEvent.click(blue);

    await vi.waitFor(() => expect(onNeedsCloud).toHaveBeenCalledTimes(1));
    expect(sdkMock.setMlWorkloadRoute).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
