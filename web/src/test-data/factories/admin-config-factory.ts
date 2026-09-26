import type { AdminConfigDto } from '@immich/sdk';

/**
 * A slice of the admin configuration with the shapes the FL-66 settings draft rules care about:
 * plain values, arrays, secrets, a URL carrying a key, server-kept values and an unset id.
 */
export const adminConfigFixture = () =>
  ({
    trash: { enabled: true, days: 30 },
    ffmpeg: { crf: 23, acceptedVideoCodecs: ['h264'] },
    notifications: {
      smtp: {
        enabled: false,
        from: '',
        replyTo: '',
        transport: { host: '', port: 587, secure: false, username: '', password: 'smtp-secret', ignoreCert: false },
      },
    },
    oauth: { enabled: false, clientSecret: 'oauth-secret', issuerUrl: '' },
    passwordLogin: { enabled: true },
    map: { enabled: true, lightStyle: 'https://tiles.example.com/light.json?key=abc123', darkStyle: '' },
    server: { name: '', externalDomain: '', loginPageMessage: '', publicUsers: true },
    machineLearning: {
      enabled: true,
      urls: ['http://ml:3003'],
      imageDescription: { modelName: 'model-a', pendingRequeueAt: null, lastConfigChangeAt: null },
    },
    physicalDeduplication: { enabled: false, masterUserId: null },
  }) as unknown as AdminConfigDto;

/** The fixture with a change applied. */
export const adminConfigWith = (mutate: (config: AdminConfigDto) => void) => {
  const config = adminConfigFixture();
  mutate(config);
  return config;
};
