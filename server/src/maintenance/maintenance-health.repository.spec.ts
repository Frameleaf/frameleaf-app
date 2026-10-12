import { healthCheckEnv } from 'src/maintenance/maintenance-health.repository.js';

describe('healthCheckEnv (FL-294)', () => {
  it('starts the check server on its own loopback address under the FRAMELEAF_ names', () => {
    expect(healthCheckEnv({ DB_HOSTNAME: 'db' })).toEqual({
      DB_HOSTNAME: 'db',
      FRAMELEAF_HOST: '127.0.0.1',
      FRAMELEAF_PORT: '33001',
      FRAMELEAF_LOG_LEVEL: 'log',
    });
  });

  it('keeps the readiness marker observable without changing the quiet parent or retaining a conflicting alias', () => {
    const parent = { FRAMELEAF_LOG_LEVEL: 'warn', IMMICH_LOG_LEVEL: 'error', DB_HOSTNAME: 'db' };
    const env = healthCheckEnv(parent);

    expect(env.FRAMELEAF_LOG_LEVEL).toBe('log');
    expect(env).not.toHaveProperty('IMMICH_LOG_LEVEL');
    expect(env.DB_HOSTNAME).toBe('db');
    expect(parent).toEqual({ FRAMELEAF_LOG_LEVEL: 'warn', IMMICH_LOG_LEVEL: 'error', DB_HOSTNAME: 'db' });
  });

  it('drops the deprecated IMMICH_ names, which would otherwise conflict with the check address', () => {
    const env = healthCheckEnv({ IMMICH_HOST: '0.0.0.0', IMMICH_PORT: '2283', FRAMELEAF_PORT: '2283' });

    expect(env).not.toHaveProperty('IMMICH_HOST');
    expect(env).not.toHaveProperty('IMMICH_PORT');
    expect(env).toMatchObject({ FRAMELEAF_HOST: '127.0.0.1', FRAMELEAF_PORT: '33001' });
  });
});
