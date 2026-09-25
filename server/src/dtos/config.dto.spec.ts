import z from 'zod';
import {
  AdminConfigDto,
  AdminConfigSchema,
  PublicConfigDto,
  UserConfigDto,
  defaults,
  mapPublicConfig,
  mapUserConfig,
  readFrameleafCloudConfig,
} from 'src/dtos/config.dto.js';
import { MlWorkload } from 'src/enum.js';
import { cloudModelFor } from 'src/utils/frameleaf-cloud.js';
import { getKeysDeep } from 'src/utils/misc.js';

const PUBLIC_PROPERTIES = [
  // FL-158: the Sign in with Frameleaf button
  'frameleafCloud.signIn.buttonText',
  'frameleafCloud.signIn.showOnLocalLogin',
  'oauth.autoLaunch',
  'oauth.buttonText',
  'oauth.enabled',
  'passwordLogin.enabled',
  'server.loginPageMessage',
  // FL-71 (CC-4): the server name is shown on the sign-in screen and in the Command Center.
  'server.name',
  'theme.customCss',
];

/** FL-158: worked out per request, not stored configuration. */
const FRAMELEAF_PUBLIC = [
  'frameleaf.localUrl',
  'frameleaf.relayHost',
  'frameleaf.sameNetwork',
  'frameleaf.signInAvailable',
  'frameleaf.signInRequired',
  'frameleaf.via',
];

describe('config visibility', () => {
  it('should expose every property to admins', () => {
    const paths = getKeysDeep(defaults);

    expect(paths).toEqual(expect.arrayContaining(PUBLIC_PROPERTIES));
    expect(paths).toContain('oauth.clientSecret');
    expect(paths.length).toBeGreaterThan(100);
  });

  it('should expose the public properties to everyone', () => {
    expect(getKeysDeep(mapPublicConfig(defaults)).sort()).toEqual([...FRAMELEAF_PUBLIC, ...PUBLIC_PROPERTIES].sort());
  });

  it('should expose everything public to logged in users as well', () => {
    expect(getKeysDeep(mapUserConfig(defaults))).toEqual(expect.arrayContaining(PUBLIC_PROPERTIES));
  });

  it('should accept the defaults with the admin schema', () => {
    expect(AdminConfigDto.schema.safeParse(defaults)).toEqual(expect.objectContaining({ success: true }));
  });

  it('should map the defaults onto the user and public schemas', () => {
    expect(UserConfigDto.schema.safeParse(mapUserConfig(defaults))).toEqual(expect.objectContaining({ success: true }));
    expect(PublicConfigDto.schema.safeParse(mapPublicConfig(defaults))).toEqual(
      expect.objectContaining({ success: true }),
    );
  });

  it('should not leak admin properties into the public config', () => {
    const config = mapPublicConfig(defaults) as Record<string, any>;

    expect(config.oauth).toEqual({
      autoLaunch: defaults.oauth.autoLaunch,
      buttonText: defaults.oauth.buttonText,
      enabled: defaults.oauth.enabled,
    });
    expect(config.job).toBeUndefined();
    expect(config.image).toBeUndefined();
    expect(config.notifications).toBeUndefined();
  });

  it('should keep the visibility metadata out of the schemas', () => {
    for (const schema of [AdminConfigDto.schema, UserConfigDto.schema, PublicConfigDto.schema]) {
      const json = JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
      expect(json).not.toContain('visibility');
    }
  });
});

describe('Frameleaf Cloud local-only models (FL-146)', () => {
  const withModel = (routing: 'local' | 'both' | 'cloud', model: string) => ({
    ...defaults,
    frameleafCloud: {
      cloudMl: {
        ...defaults.frameleafCloud.cloudMl,
        routing: { ...defaults.frameleafCloud.cloudMl.routing, descriptions: routing },
        models: { ...defaults.frameleafCloud.cloudMl.models, descriptions: model },
      },
    },
  });

  it('refuses Qwen2.5-VL-3B for work allowed on Frameleaf Cloud', () => {
    for (const routing of ['both', 'cloud'] as const) {
      for (const model of ['Qwen/Qwen2.5-VL-3B-Instruct', 'llmware/qwen2.5-vl-3b-ov', 'nllb-clip-base-siglip__v1']) {
        const result = AdminConfigSchema.safeParse(withModel(routing, model));
        expect(result.success, `${routing} ${model}`).toBe(false);
        expect(result.error?.issues[0].path).toEqual(['frameleafCloud', 'cloudMl', 'models', 'descriptions']);
      }
    }
  });

  it('keeps it available for work that runs on this server only', () => {
    expect(AdminConfigSchema.safeParse(withModel('local', 'Qwen/Qwen2.5-VL-3B-Instruct')).success).toBe(true);
    expect(AdminConfigSchema.safeParse(withModel('cloud', 'qwen3.5-9b@1')).success).toBe(true);
  });

  it('resets only the local-only model entry of a stored configuration, keeping the rest, and warns', () => {
    const stored = withModel('cloud', 'Qwen/Qwen2.5-VL-3B-Instruct').frameleafCloud;
    stored.cloudMl.enabled = true;
    stored.cloudMl.routing.upscale = 'both';
    stored.cloudMl.models.upscale = 'realesrgan-x4plus@1';
    stored.cloudMl.autoDescribe = { enabled: true, dailyBudgetUsd: 7.5 };
    const warn = vi.fn();

    const read = readFrameleafCloudConfig(stored, warn);

    expect(read.cloudMl).toEqual({
      ...stored.cloudMl,
      models: { ...stored.cloudMl.models, descriptions: 'qwen3.5-9b@1' },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/Qwen2\.5-VL-3B-Instruct runs on this server only/);
  });

  it('gives cloud descriptions their own licensed default, never the local description model', () => {
    expect(defaults.frameleafCloud.cloudMl.models.descriptions).toBe('qwen3.5-9b@1');
    expect(defaults.frameleafCloud.cloudMl.models.descriptions).not.toBe(
      defaults.machineLearning.imageDescription.modelName,
    );
    expect(cloudModelFor(MlWorkload.Enrichment, '')).toBe('qwen3.5-9b@1');
    expect(cloudModelFor(MlWorkload.Enrichment, defaults.machineLearning.imageDescription.modelName)).toBe(
      'qwen3.5-9b@1',
    );
    expect(cloudModelFor(MlWorkload.Enrichment, 'qwen3.5-27b@1')).toBe('qwen3.5-27b@1');
    expect(cloudModelFor(MlWorkload.Upscale, null)).toBeNull();
  });
});
