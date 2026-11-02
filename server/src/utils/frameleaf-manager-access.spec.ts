import { managerAccessUrl } from 'src/utils/frameleaf-manager-access.js';

describe('Manager Storage link', () => {
  const managed = {
    FRAMELEAF_MANAGER_INSTALLATION: 'a'.repeat(12),
    FRAMELEAF_MANAGER_TOKEN_FILE: '/run/frameleaf/manager-token',
  };
  it('only returns an explicitly configured HTTP or HTTPS origin for a managed installation', () => {
    expect(managerAccessUrl({ ...managed, FRAMELEAF_MANAGER_URL: 'https://nas.example:9443' })).toBe(
      'https://nas.example:9443',
    );
    expect(managerAccessUrl({ FRAMELEAF_MANAGER_URL: 'https://nas.example:9443' })).toBeNull();
    expect(managerAccessUrl({ ...managed, FRAMELEAF_MANAGER_URL: 'http://nas.local:2282' })).toBe(
      'http://nas.local:2282',
    );
    expect(managerAccessUrl(managed)).toBeNull();
  });
  it.each([
    'ftp://nas.example',
    'https://user:password@nas.example',
    'https://nas.example/path',
    'https://nas.example/?token=secret',
    'https://nas.example/#move',
    'javascript:alert(1)',
    'bad',
  ])('refuses %s', (url) => {
    expect(managerAccessUrl({ ...managed, FRAMELEAF_MANAGER_URL: url })).toBeNull();
  });
});
