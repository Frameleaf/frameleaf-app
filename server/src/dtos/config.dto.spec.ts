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
  // FL-426: the sign-in page shows the welcome message as typed or as cleaned web formatting.
  'server.loginPageMessageFormat',
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
  'frameleaf.signInOrigin',
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

  it('should keep custom styling in use for a configuration that does not say (FL-368)', () => {
    const parsed = AdminConfigSchema.safeParse({ ...defaults, theme: { customCss: 'body {}' } });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.theme).toEqual({ customCss: 'body {}', customCssEnabled: true });
    expect(defaults.theme.customCssEnabled).toBe(true);
    // The switch is for administrators: only the text itself is public, as before.
    expect((mapPublicConfig(defaults) as Record<string, any>).theme).toEqual({ customCss: '' });
  });

  it('should keep the FL-426 defaults for a configuration that does not name them', () => {
    const { loginPageMessageFormat: _format, timeZone: _zone, ...server } = defaults.server;
    const { invitationFirstLine: _line, showBranding: _branding, ...email } = defaults.templates.email;
    const parsed = AdminConfigSchema.safeParse({ ...defaults, server, templates: { ...defaults.templates, email } });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.server).toEqual(expect.objectContaining({ loginPageMessageFormat: 'plain', timeZone: '' }));
    expect(parsed.data?.templates.email).toEqual(
      expect.objectContaining({ invitationFirstLine: '', showBranding: true }),
    );
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

describe('search and faces run in one place', () => {
  // Their index comes from one model, so a "both" route for them is never kept: it is dropped where the
  // settings are saved (the admin schema) and where they are read back. Their one place is the destination route.
  const routing = { ...defaults.frameleafCloud.cloudMl.routing, search: 'both', faces: 'both', clip: 'both' };

  it('drops a both route for search or faces when the settings are saved', () => {
    const parsed = AdminConfigSchema.safeParse({
      ...defaults,
      frameleafCloud: { ...defaults.frameleafCloud, cloudMl: { ...defaults.frameleafCloud.cloudMl, routing } },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.frameleafCloud.cloudMl.routing).toEqual(defaults.frameleafCloud.cloudMl.routing);
  });

  it('drops a both route for search or faces when the settings are read, keeping the rest', () => {
    const warn = vi.fn();
    const read = readFrameleafCloudConfig(
      { cloudMl: { ...defaults.frameleafCloud.cloudMl, enabled: true, routing } },
      warn,
    );
    expect(read.cloudMl.enabled).toBe(true);
    expect(read.cloudMl.routing).toEqual(defaults.frameleafCloud.cloudMl.routing);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Frameleaf Cloud models (FL-146, FL-183, FL-186)', () => {
  it('has no model setting: the model is the SKU saved on the workload route or the catalogue default', () => {
    expect(defaults.frameleafCloud.cloudMl).not.toHaveProperty('models');
    const parsed = AdminConfigSchema.safeParse({
      ...defaults,
      frameleafCloud: {
        ...defaults.frameleafCloud,
        cloudMl: { ...defaults.frameleafCloud.cloudMl, models: { descriptions: 'Qwen/Qwen2.5-VL-3B-Instruct' } },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.frameleafCloud.cloudMl).not.toHaveProperty('models');
  });

  it('drops the model slider positions an earlier version stored, keeping the rest, without a warning', () => {
    const stored = {
      cloudMl: {
        ...defaults.frameleafCloud.cloudMl,
        enabled: true,
        routing: { ...defaults.frameleafCloud.cloudMl.routing, descriptions: 'cloud', upscale: 'both' },
        models: { descriptions: 'Qwen/Qwen2.5-VL-3B-Instruct', upscale: 'realesrgan-x4plus@1' },
        autoDescribe: { enabled: true, dailyBudgetUsd: 7.5 },
      },
    };
    const warn = vi.fn();

    const read = readFrameleafCloudConfig(stored, warn);

    const { models: _models, ...kept } = stored.cloudMl;
    expect(read.cloudMl).toEqual(kept);
    expect(warn).not.toHaveBeenCalled();
  });

  it('names the routed model or the catalogue default for cloud work, never a configured name (FL-183)', () => {
    // A cloud job names the routed SKU or the catalogue's marked default, never a configured name.
    expect(cloudModelFor(MlWorkload.Enrichment, '', { defaultModels: {} })).toBeNull();
    expect(cloudModelFor(MlWorkload.Enrichment, null, { defaultModels: { descriptions: 'ms_K6WT70CS' } })).toBe(
      'ms_K6WT70CS',
    );
    // a chosen model is named as chosen, never swapped for the default; no model is local only (FL-451)
    expect(
      cloudModelFor(MlWorkload.Enrichment, 'Qwen/Qwen2.5-VL-3B-Instruct', {
        defaultModels: { descriptions: 'ms_K6WT70CS' },
      }),
    ).toBe('Qwen/Qwen2.5-VL-3B-Instruct');
    expect(cloudModelFor(MlWorkload.Upscale, null, null)).toBeNull();
  });
});
