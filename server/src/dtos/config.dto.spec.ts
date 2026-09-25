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
import { getKeysDeep } from 'src/utils/misc.js';

const PUBLIC_PROPERTIES = [
  'oauth.autoLaunch',
  'oauth.buttonText',
  'oauth.enabled',
  'passwordLogin.enabled',
  'server.loginPageMessage',
  // FL-71 (CC-4): the server name is shown on the sign-in screen and in the Command Center.
  'server.name',
  'theme.customCss',
];

describe('config visibility', () => {
  it('should expose every property to admins', () => {
    const paths = getKeysDeep(defaults);

    expect(paths).toEqual(expect.arrayContaining(PUBLIC_PROPERTIES));
    expect(paths).toContain('oauth.clientSecret');
    expect(paths.length).toBeGreaterThan(100);
  });

  it('should expose the public properties to everyone', () => {
    expect(getKeysDeep(mapPublicConfig(defaults)).sort()).toEqual(PUBLIC_PROPERTIES);
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

  it('reads a stored configuration that names it for the cloud back as the defaults', () => {
    expect(readFrameleafCloudConfig(withModel('cloud', 'Qwen/Qwen2.5-VL-3B-Instruct').frameleafCloud)).toEqual(
      defaults.frameleafCloud,
    );
  });
});
