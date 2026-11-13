import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { messages } from './messages.mjs';

const integration = fileURLToPath(new URL('.', import.meta.url));
const repository = join(integration, '../..');
const output = join(integration, '.artifacts');
const staging = mkdtempSync(join(tmpdir(), 'frameleaf-assistant-'));
const bundle = join(staging, 'bundle');
const npm = process.env.npm_execpath;
if (!npm) {
  throw new Error('Run this script with npm run bundle.');
}

const runNpm = (args, cwd) => execFileSync(process.execPath, [npm, ...args], { cwd, stdio: 'inherit' });

try {
  mkdirSync(output, { recursive: true });
  mkdirSync(bundle);
  for (const file of [
    'server.mjs',
    'https.mjs',
    'oauth.mjs',
    'messages.mjs',
    'messages.json',
    'manifest.json',
    'package.json',
    'package-lock.json',
  ]) {
    copyFileSync(join(integration, file), join(bundle, file));
  }
  const resources = join(bundle, 'mcpb-resources');
  mkdirSync(resources);
  for (const [locale, text] of Object.entries(messages)) {
    const overrides = {
      description: text.extensionDescription,
      tools: [
        { name: 'search_library', description: text.searchDescription },
        { name: 'list_albums', description: text.listDescription },
        { name: 'get_album', description: text.albumDescription },
      ],
      user_config: {
        library_url: { title: text.libraryAddress, description: text.libraryAddressHelp },
      },
    };
    writeFileSync(join(resources, `${locale}.json`), JSON.stringify(overrides, null, 2));
  }
  copyFileSync(join(repository, 'LICENSE'), join(bundle, 'LICENSE'));
  copyFileSync(join(repository, 'web/static/manifest-icon-512.maskable.png'), join(bundle, 'icon.png'));

  const { packages } = JSON.parse(readFileSync(join(bundle, 'package-lock.json'), 'utf8'));
  const flags = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  runNpm([...flags, '--os=darwin', '--cpu=arm64'], bundle);
  for (const [os, cpu, abi] of [
    ['darwin', 'x64', ''],
    ['win32', 'x64', '-msvc'],
    ['win32', 'arm64', '-msvc'],
  ]) {
    const nativePackage = `node_modules/@napi-rs/keyring-${os}-${cpu}${abi}`;
    if (!packages[nativePackage]?.integrity) {
      throw new Error(`Missing lockfile integrity for ${nativePackage}.`);
    }
    const platform = join(staging, `${os}-${cpu}`);
    mkdirSync(platform);
    for (const file of ['package.json', 'package-lock.json']) {
      copyFileSync(join(bundle, file), join(platform, file));
    }
    runNpm([...flags, `--os=${os}`, `--cpu=${cpu}`], platform);
    cpSync(join(platform, nativePackage), join(bundle, nativePackage), {
      recursive: true,
    });
  }

  const keyringLicense = join(integration, 'KEYRING-LICENSE');
  for (const osCpu of ['darwin-arm64', 'darwin-x64', 'win32-x64-msvc', 'win32-arm64-msvc']) {
    copyFileSync(keyringLicense, join(bundle, 'node_modules/@napi-rs', `keyring-${osCpu}`, 'LICENSE'));
  }
  copyFileSync(keyringLicense, join(bundle, 'node_modules/@napi-rs/keyring/LICENSE'));
  runNpm(['exec', '--offline', '--', 'mcpb', 'pack', bundle, join(output, 'frameleaf-assistant.mcpb')], integration);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
