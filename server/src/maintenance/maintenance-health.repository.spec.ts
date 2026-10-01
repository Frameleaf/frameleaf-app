import { healthCheckEnv } from 'src/maintenance/maintenance-health.repository.js';

describe('healthCheckEnv (FL-294)', () => {
  it('starts the check server on its own loopback address under the FRAMELEAF_ names', () => {
    expect(healthCheckEnv({ DB_HOSTNAME: 'db' })).toEqual({
      DB_HOSTNAME: 'db',
      FRAMELEAF_HOST: '127.0.0.1',
      FRAMELEAF_PORT: '33001',
    });
  });

  it('drops the deprecated IMMICH_ names, which would otherwise conflict with the check address', () => {
    const env = healthCheckEnv({ IMMICH_HOST: '0.0.0.0', IMMICH_PORT: '2283', FRAMELEAF_PORT: '2283' });

    expect(env).not.toHaveProperty('IMMICH_HOST');
    expect(env).not.toHaveProperty('IMMICH_PORT');
    expect(env).toMatchObject({ FRAMELEAF_HOST: '127.0.0.1', FRAMELEAF_PORT: '33001' });
  });
});
