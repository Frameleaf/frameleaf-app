import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Mock } from 'vitest';
import { AssetDevelopMaskKind, AssetDevelopPreset } from 'src/dtos/asset-develop.dto.js';
import { DEVELOP_PRESET_MAX, DevelopPresetUpdateDto } from 'src/dtos/photo-tools.dto.js';
import { type DevelopPreset, PhotoToolsRepository } from 'src/repositories/photo-tools.repository.js';
import { PhotoToolsService, normalizePresetSettings } from 'src/services/photo-tools.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getMocks } from 'test/utils.js';

const presetRow = (overrides: Partial<DevelopPreset> = {}): DevelopPreset => ({
  id: '5b1f0c3e-7a2d-4c11-8e0f-2b3c4d5e6f70',
  ownerId: authStub.user1.user.id,
  name: 'Golden hour',
  settings: normalizePresetSettings({ temperature: 25 }) as never,
  createdAt: new Date('2026-09-23T08:00:00Z') as never,
  updatedAt: new Date('2026-09-23T08:00:00Z') as never,
  ...overrides,
});

describe(PhotoToolsService.name, () => {
  let sut: PhotoToolsService;
  let repository: { [K in keyof PhotoToolsRepository]: Mock<(...args: any[]) => any> };

  beforeEach(() => {
    const mocks = getMocks();
    repository = {
      listPresets: vi.fn().mockResolvedValue([]),
      countPresets: vi.fn().mockResolvedValue(0),
      getPreset: vi.fn(),
      getPresetByName: vi.fn(),
      createPreset: vi.fn().mockImplementation((input) => Promise.resolve(presetRow(input))),
      updatePreset: vi.fn(),
      deletePreset: vi.fn(),
      createExport: vi.fn(),
      listExports: vi.fn(),
      getExport: vi.fn(),
    };
    sut = new PhotoToolsService(mocks.logger as never, repository as unknown as PhotoToolsRepository);
  });

  it('saves a preset with normalized settings for the signed-in account only', async () => {
    const result = await sut.createPreset(authStub.user1, {
      name: 'Golden hour',
      settings: {
        ...normalizePresetSettings({}),
        exposure: 9,
        preset: AssetDevelopPreset.Warm,
        masks: [
          {
            id: 'sky',
            name: null,
            kind: AssetDevelopMaskKind.Linear,
            enabled: true,
            invert: false,
            x: 0.5,
            y: 0,
            radiusX: 0.25,
            radiusY: 0.25,
            endX: 0.5,
            endY: 0.6,
            feather: 50,
            amount: 100,
            adjustments: { ...normalizePresetSettings({}).masks[0]?.adjustments, exposure: -0.5 } as never,
          },
        ],
      },
    });
    expect(repository.createPreset).toHaveBeenCalledWith({
      ownerId: authStub.user1.user.id,
      name: 'Golden hour',
      settings: expect.objectContaining({ exposure: 2, preset: AssetDevelopPreset.Warm }),
    });
    const stored = repository.createPreset.mock.calls[0][0].settings;
    expect(stored).not.toHaveProperty('crop');
    expect(stored.masks[0].adjustments).toMatchObject({ exposure: -0.5, contrast: 0 });
    expect(result.settings.exposure).toBe(2);
  });

  it('keeps Brilliance and leaves brush and bitmap masks and Clean Up out of a preset (FL-233)', () => {
    const settings = normalizePresetSettings({
      brilliance: 25,
      masks: [
        { id: 'r', kind: AssetDevelopMaskKind.Radial, x: 0.5, y: 0.5 },
        { id: 'b', kind: AssetDevelopMaskKind.Brush, strokes: [{ points: [[0.1, 0.1]], radius: 0.05, erase: false }] },
        { id: 's', kind: AssetDevelopMaskKind.Sky, artifact: 'a'.repeat(64) },
      ],
      cleanup: [{ id: 'p', method: 'pixelate', region: { x: 0, y: 0, w: 0.2, h: 0.2 } }],
    } as never);
    expect(settings.brilliance).toBe(25);
    expect(settings.masks.map(({ id }) => id)).toEqual(['r']);
    expect(settings).not.toHaveProperty('cleanup');
  });

  it('refuses a duplicate name, including a race on the unique key', async () => {
    repository.getPresetByName.mockResolvedValue(presetRow());
    await expect(
      sut.createPreset(authStub.user1, { name: 'Golden hour', settings: {} as never }),
    ).rejects.toBeInstanceOf(ConflictException);
    repository.getPresetByName.mockResolvedValue(undefined);
    repository.createPreset.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
    await expect(
      sut.createPreset(authStub.user1, { name: 'Golden hour', settings: {} as never }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('caps how many presets one account keeps', async () => {
    repository.countPresets.mockResolvedValue(DEVELOP_PRESET_MAX);
    await expect(sut.createPreset(authStub.user1, { name: 'One more', settings: {} as never })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.createPreset).not.toHaveBeenCalled();
  });

  it("answers 404 for another account's preset on update and delete", async () => {
    repository.getPreset.mockResolvedValue(undefined);
    repository.deletePreset.mockResolvedValue(false);
    await expect(sut.updatePreset(authStub.user1, presetRow().id, { name: 'Mine now' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(sut.deletePreset(authStub.user1, presetRow().id)).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.getPreset).toHaveBeenCalledWith(authStub.user1.user.id, presetRow().id);
    expect(repository.deletePreset).toHaveBeenCalledWith(authStub.user1.user.id, presetRow().id);
  });

  describe('updating from a client that does not show every field (FL-303)', () => {
    /** What the web editor sends: its sliders (no Brilliance), the look, the strength and the masks. */
    const webSettings = {
      exposure: 0.5,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      temperature: -30,
      tint: 0,
      vibrance: 0,
      saturation: 0,
      clarity: 0,
      dehaze: 0,
      vignette: 0,
      grain: 0,
      sharpen: 0,
      noiseReduction: 0,
      preset: AssetDevelopPreset.Cool,
      presetStrength: 80,
      masks: [],
    };

    const updateFromWeb = async (stored: Record<string, unknown>) => {
      repository.getPreset.mockResolvedValue(presetRow({ settings: stored as never }));
      repository.updatePreset.mockImplementation((_owner, _id, patch) =>
        Promise.resolve(presetRow({ ...patch, settings: patch.settings ?? stored })),
      );
      const dto = DevelopPresetUpdateDto.schema.parse({ settings: webSettings }) as DevelopPresetUpdateDto;
      const result = await sut.updatePreset(authStub.user1, presetRow().id, dto);
      return { result, written: repository.updatePreset.mock.calls[0][2].settings as Record<string, unknown> };
    };

    it('keeps a Brilliance of 0.4 set in another app', async () => {
      const { result, written } = await updateFromWeb({ ...normalizePresetSettings({ brilliance: 0.4 }) });
      expect(written).toMatchObject({ brilliance: 0.4, exposure: 0.5, temperature: -30, presetStrength: 80 });
      expect(result.settings).toMatchObject({ brilliance: 0.4, exposure: 0.5, preset: AssetDevelopPreset.Cool });
    });

    it('keeps a field this server does not know about', async () => {
      const { written } = await updateFromWeb({
        ...normalizePresetSettings({ brilliance: 0.4 }),
        futureTone: { amount: 12 },
      });
      expect(written).toMatchObject({ futureTone: { amount: 12 }, brilliance: 0.4, temperature: -30 });
    });

    it('still replaces what the client sends, masks included', async () => {
      const stored = normalizePresetSettings({
        brilliance: 0.4,
        masks: [{ id: 'old', kind: AssetDevelopMaskKind.Radial }],
      } as never);
      const { written } = await updateFromWeb({ ...stored });
      expect(written.masks).toEqual([]);
      expect(written).toMatchObject({ exposure: 0.5, brilliance: 0.4 });
    });

    it('keeps stored masks when the update leaves them out', async () => {
      const stored = normalizePresetSettings({ masks: [{ id: 'old', kind: AssetDevelopMaskKind.Radial }] } as never);
      repository.getPreset.mockResolvedValue(presetRow({ settings: stored as never }));
      repository.updatePreset.mockImplementation((_owner, _id, patch) => Promise.resolve(presetRow(patch)));
      await sut.updatePreset(
        authStub.user1,
        presetRow().id,
        DevelopPresetUpdateDto.schema.parse({ settings: { exposure: 1 } }) as DevelopPresetUpdateDto,
      );
      const written = repository.updatePreset.mock.calls[0][2].settings as Record<string, unknown>;
      expect(written).toMatchObject({ exposure: 1, masks: [expect.objectContaining({ id: 'old' })] });
    });
  });

  it('renames and replaces settings in one update', async () => {
    repository.getPreset.mockResolvedValue(presetRow());
    repository.updatePreset.mockImplementation((_owner, _id, patch) =>
      Promise.resolve(presetRow({ ...patch, settings: patch.settings ?? presetRow().settings })),
    );
    const result = await sut.updatePreset(authStub.user1, presetRow().id, {
      name: 'Blue hour',
      settings: { ...normalizePresetSettings({}), temperature: -30 },
    });
    expect(repository.updatePreset).toHaveBeenCalledWith(authStub.user1.user.id, presetRow().id, {
      name: 'Blue hour',
      settings: expect.objectContaining({ temperature: -30 }),
    });
    expect(result).toMatchObject({ name: 'Blue hour', settings: expect.objectContaining({ temperature: -30 }) });
  });
});
