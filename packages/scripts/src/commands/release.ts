import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver, { SemVer } from 'semver';
import {
  JsonFile,
  RELEASE_TYPES,
  ReleaseError,
  ReleaseInputError,
  type ReleaseOptions,
  type ReleaseType,
  TextFile,
} from 'src/types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../');

const Files = {
  PackageJson: {
    Root: join(root, 'package.json'),
    Rest: ['web', 'packages/cli', 'packages/sdk', 'e2e', 'server'].map(
      (folder) => join(root, folder, `package.json`),
    ),
  },
  ExampleEnv: join(root, 'docker/example.env'),
  Docs: {
    Env: join(root, 'docs/docs/install/environment-variables.md'),
    Upgrading: join(root, 'docs/docs/install/upgrading.md'),
  },
};

export const handleRelease = ({ type }: ReleaseOptions) => {
  const versionRaw = getVersion();
  const newVersionRaw = getNewVersion(versionRaw, type);
  const newVersion = semver.parse(normalize(newVersionRaw));
  if (!newVersion) {
    throw new ReleaseInputError();
  }

  // pump versions everywhere

  // package.json
  for (const file of [Files.PackageJson.Root, ...Files.PackageJson.Rest]) {
    pump(file, /^  "version": ".*"/m, `  "version": "${newVersionRaw}"`);
  }

  // machine-learning
  execSync(`uv version --directory machine-learning ${newVersionRaw}`, {
    cwd: root,
    stdio: 'inherit',
  });

  if (type === 'release') {
    // docker tag references (v2, :v2, etc) in docs
    const major = `v${newVersion.major}`;

    // sync major tag references in docs and example env file
    pump(Files.ExampleEnv, /^FRAMELEAF_VERSION=v\d+$/m, `FRAMELEAF_VERSION=${major}`);
    pump(Files.Docs.Env, /(`FRAMELEAF_VERSION`.*?)`v\d+`/, `$1\`${major}\``);
    pump(Files.Docs.Upgrading, /:v\d+/, `:${major}`);
  }

  if (process.env.GITHUB_ENV) {
    // make available for following steps
    appendFileSync(
      process.env.GITHUB_ENV,
      `FRAMELEAF_VERSION=v${newVersionRaw}\n`,
    );
  }

  return newVersionRaw;
};

const getVersion = () =>
  new JsonFile<{ version: string }>(Files.PackageJson.Root).read().version;

export const getNewVersion = (versionRaw: string, type: string) => {
  if (!versionRaw || !type || !RELEASE_TYPES.includes(type as ReleaseType)) {
    throw new ReleaseInputError();
  }

  versionRaw = normalize(versionRaw);

  const version = semver.parse(versionRaw);
  if (!version) {
    throw new ReleaseInputError();
  }

  let newVersionRaw;
  let valid = true;

  switch (type) {
    case 'patch':
    case 'prepatch':
    case 'minor': {
      newVersionRaw = inc(version, type);
      // can only use while not in a prerelease
      valid = !isPrerelease(version);
      break;
    }

    case 'preminor':
    case 'premajor': {
      // cutting the next release line is allowed while main sits on a prerelease
      newVersionRaw = inc(version, type);
      break;
    }

    case 'prerelease': {
      newVersionRaw = inc(version, type);
      // can only use while in a prerelease
      valid = isPrerelease(version);
      break;
    }

    case 'release': {
      // drop prerelease part
      newVersionRaw = `${version.major}.${version.minor}.${version.patch}`;
      // can only use to promote a prerelease to a release (no version change)
      valid = isPrerelease(version);
      break;
    }

    default: {
      throw new ReleaseInputError();
    }
  }

  if (!newVersionRaw) {
    throw new ReleaseInputError();
  }

  newVersionRaw = normalize(newVersionRaw);

  const newVersion = semver.parse(newVersionRaw);
  if (!newVersion) {
    throw new ReleaseInputError();
  }

  const invalidUpgrade =
    isPrerelease(version) &&
    !isPrerelease(newVersion) &&
    (version.major !== newVersion.major ||
      version.minor !== newVersion.minor ||
      version.patch !== newVersion.patch);

  if (!valid || invalidUpgrade) {
    throw new ReleaseError({
      version: versionRaw,
      newVersion: newVersionRaw,
    });
  }

  return newVersionRaw;
};

const pump = (path: string, pattern: RegExp, replacement: string) => {
  const file = new TextFile(path);
  const update = file.read().replace(pattern, replacement);
  file.write(update);
};

const isPrerelease = (version: SemVer) => version.prerelease.length > 0;

/**
 * @param {SemVer} version
 * @returns {boolean}
 */
const inc = (version: SemVer, type: ReleaseType) =>
  `v${semver.inc(version, type, {}, 'rc')}`;

const normalize = (version: string) =>
  version.startsWith('v') ? version.slice(1) : version;
