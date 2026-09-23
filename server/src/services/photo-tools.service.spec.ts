import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Mock } from 'vitest';
import { AssetDevelopMaskKind, AssetDevelopPreset } from 'src/dtos/asset-develop.dto.js';
import { DEVELOP_PRESET_MAX } from 'src/dtos/photo-tools.dto.js';
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
