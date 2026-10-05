import { Refusal } from './contracts.js';

/** Read one inert INI value. Never source/evaluate Unraid's configuration as shell code. */
export function configuredAppdata(contents: string): string | null {
  const lines = contents.split(/\r?\n/).filter((line) => /^\s*DOCKER_APP_CONFIG_PATH\s*=/.test(line));
  if (lines.length > 1) throw new Refusal('ambiguous_unraid_appdata_setting');
  if (!lines.length) return null;
  let value = lines[0].slice(lines[0].indexOf('=') + 1).trim();
  if (/^["']/.test(value)) {
    if (value.at(-1) !== value[0]) throw new Refusal('invalid_unraid_appdata_setting');
    value = value.slice(1, -1);
  }
  return value ? appdataPath(value) : null;
}

export function appdataPath(value: string): string {
  const path = value.replace(/\/+$/, '');
  if (
    !path.startsWith('/') ||
    /[\x00-\x1f\x7f,:"'`$\\]/.test(path) ||
    path.split('/').some((p) => p === '.' || p === '..') ||
    path.includes('//')
  ) {
    throw new Refusal('invalid_appdata_path');
  }
  return path;
}

export function appdataDefaults(env: Record<string, string | undefined>, configuration: string | null) {
  const detected = env.DOCKER_APP_CONFIG_PATH
    ? appdataPath(env.DOCKER_APP_CONFIG_PATH)
    : configuration === null
      ? null
      : configuredAppdata(configuration);
  const unraid = configuration !== null || env.MANAGER_PLATFORM === 'unraid';
  const detectedPath = detected ?? (unraid ? '/mnt/user/appdata' : null);
  const roots = (env.MANAGER_DATABASE_ROOTS ?? '').split(':').filter(Boolean).map(appdataPath);
  // A launch-time administrator override wins. Otherwise use Unraid's actual configured default.
  const suggestedPath = env.MANAGER_APPDATA_ROOT
    ? appdataPath(env.MANAGER_APPDATA_ROOT)
    : (detectedPath ?? roots[0] ?? '');
  return {
    detectedPath,
    suggestedPath,
    roots,
    platform: unraid ? 'unraid' : 'linux',
    source: env.DOCKER_APP_CONFIG_PATH
      ? 'environment'
      : detected
        ? 'unraid-config'
        : unraid
          ? 'unraid-default'
          : 'configured',
  };
}
