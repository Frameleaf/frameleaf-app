import { AssetDevelopImportDto, DevelopPresetCreateDto, DevelopPresetUpdateDto } from 'src/dtos/photo-tools.dto.js';

describe('photo tools DTOs (FL-64)', () => {
  it('fills preset settings from defaults and never carries geometry', () => {
    const parsed = DevelopPresetCreateDto.schema.safeParse({ name: ' Golden hour ', settings: { temperature: 20 } });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.name).toBe('Golden hour');
    expect(parsed.data?.settings).toMatchObject({ temperature: 20, exposure: 0, masks: [], presetStrength: 100 });
    expect(parsed.data?.settings).not.toHaveProperty('crop');
    expect(parsed.data?.settings).not.toHaveProperty('rotation');
    expect(DevelopPresetCreateDto.schema.safeParse({ name: '', settings: {} }).success).toBe(false);
    expect(DevelopPresetCreateDto.schema.safeParse({ name: 'x', settings: { exposure: 5 } }).success).toBe(false);
  });

  it('requires a change when updating a preset', () => {
    expect(DevelopPresetUpdateDto.schema.safeParse({}).success).toBe(false);
    expect(DevelopPresetUpdateDto.schema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });

  it('requires the original a returned file was developed from, as an export or a SHA-256', () => {
    expect(AssetDevelopImportDto.schema.safeParse({}).success).toBe(false);
    expect(AssetDevelopImportDto.schema.safeParse({ exportId: '0d9f8b4e-2f7c-4a51-9d1e-6c1e4a2b3c4d' }).success).toBe(
      true,
    );
    const upper = 'AB'.repeat(32);
    expect(AssetDevelopImportDto.schema.safeParse({ sourceChecksum: upper }).data?.sourceChecksum).toBe(
      upper.toLowerCase(),
    );
    expect(AssetDevelopImportDto.schema.safeParse({ sourceChecksum: 'abc' }).success).toBe(false);
    expect(
      AssetDevelopImportDto.schema.safeParse({ sourceChecksum: 'ab'.repeat(32), renditionChecksum: 'zz' }).success,
    ).toBe(false);
  });
});
