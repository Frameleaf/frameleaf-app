// Runs only inside the isolated Manager-image helper; source is mounted read only.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

function extendedMetadata(path) {
  const run = (program, args) =>
    execFileSync(program, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (process.platform === 'linux')
    return {
      acl: run('getfacl', ['-c', '-p', '-n', '--', path]),
      attributes: run('getfattr', ['-d', '-m', '-', '-e', 'hex', '--absolute-names', '--', path])
        .split('\n')
        .filter((line) => line && !line.startsWith('#'))
        .join('\n'),
    };
  return {
    acl: run('/bin/ls', ['-ldne', path])
      .split('\n')
      .filter((line) => /^ \d+:/.test(line))
      .join('\n'),
    attributes: run('/usr/bin/xattr', [path])
      .split('\n')
      .filter(Boolean)
      .sort()
      .map((name) => [name, run('/usr/bin/xattr', ['-px', name, path]).replaceAll(/\s/g, '')]),
  };
}

async function inventory(root) {
  const entries = [];
  const device = (await fs.lstat(root, { bigint: true })).dev;
  async function visit(relative) {
    const path = relative ? join(root, relative) : root;
    const before = await fs.lstat(path, { bigint: true });
    if (
      before.dev !== device ||
      before.isSymbolicLink() ||
      !(before.isDirectory() || before.isFile()) ||
      (before.isFile() && before.nlink !== 1n)
    )
      throw new Error('unsupported_media_entry');
    const entry = {
      path: relative,
      directory: before.isDirectory(),
      mode: Number(before.mode & 0o7777n),
      uid: Number(before.uid),
      gid: Number(before.gid),
      mtime: before.mtimeNs.toString(),
      size: before.isFile() ? Number(before.size) : 0,
    };
    entry.metadata = extendedMetadata(path);
    if (before.isFile()) {
      const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await file.stat({ bigint: true });
        if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('media_source_changed');
        const hash = createHash('sha256');
        for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
        entry.sha256 = hash.digest('hex');
        const after = await file.stat({ bigint: true });
        if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
          throw new Error('media_source_changed');
      } finally {
        await file.close();
      }
    }
    entries.push(entry);
    if (before.isDirectory()) {
      for (const name of (await fs.readdir(path)).sort()) await visit(relative ? join(relative, name) : name);
      const after = await fs.lstat(path, { bigint: true });
      if (after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
        throw new Error('media_source_changed');
    }
  }
  await visit('');
  return entries;
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const summary = (entries) => ({
  files: entries.filter((e) => !e.directory).length,
  bytes: entries.reduce((n, e) => n + e.size, 0),
});
async function freeze(source, manifest) {
  const entries = await inventory(source);
  try {
    const prior = JSON.parse(await fs.readFile(manifest, 'utf8'));
    if (!equal(prior, entries)) throw new Error('media_source_changed');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.rm(manifest + '.partial', { force: true });
    const file = await fs.open(manifest + '.partial', 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(entries));
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(manifest + '.partial', manifest);
  }
  return summary(entries);
}
async function cancelled(path) {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}
async function copy(source, destination, manifest, cancel) {
  if (await cancelled(cancel)) throw new Error('media_move_cancelled');
  const expected = JSON.parse(await fs.readFile(manifest, 'utf8'));
  if (!equal(await inventory(source), expected)) throw new Error('media_source_changed');
  // Refuse links/special files before cp sees a partially copied destination.
  await inventory(destination);
  const args = process.platform === 'linux' ? ['-a', '--preserve=all', '--'] : ['-a', '--'];
  const child = spawn('cp', [...args, source + '/.', destination], { stdio: 'ignore', shell: false });
  let stopped = false;
  const timer = setInterval(async () => {
    try {
      if (await cancelled(cancel)) {
        stopped = true;
        child.kill('SIGTERM');
      }
    } catch {
      stopped = true;
      child.kill('SIGTERM');
    }
  }, 250);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('media_copy_failed')));
      child.once('close', (code) =>
        stopped
          ? reject(new Error('media_move_cancelled'))
          : code === 0
            ? resolve()
            : reject(new Error('media_copy_failed')),
      );
    });
    if (await cancelled(cancel)) throw new Error('media_move_cancelled');
    await verify(source, destination, manifest);
    for (const entry of expected) {
      const file = await fs.open(join(destination, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
    return summary(expected);
  } finally {
    clearInterval(timer);
  }
}
async function verify(source, destination, manifest) {
  const expected = JSON.parse(await fs.readFile(manifest, 'utf8'));
  if (!equal(await inventory(source), expected)) throw new Error('media_source_changed');
  if (!equal(await inventory(destination), expected)) throw new Error('media_copy_mismatch');
  return summary(expected);
}
module.exports = { freeze, copy, verify, measure: (source) => inventory(source).then(summary) };
if (require.main === module) {
  const action = process.argv[2];
  if (!['measure', 'freeze', 'copy', 'verify'].includes(action)) throw new Error('invalid_media_copy_action');
  const source = '/source',
    destination = '/destination',
    manifest = '/state/manifest.json',
    cancel = '/state/cancel';
  (action === 'measure'
    ? inventory(source).then(summary)
    : action === 'freeze'
      ? freeze(source, manifest)
      : module.exports[action](source, destination, manifest, cancel)
  )
    .then((result) => process.stdout.write(JSON.stringify(result)))
    .catch((error) => {
      const safe = [
        'unsupported_media_entry',
        'media_source_changed',
        'media_copy_mismatch',
        'media_move_cancelled',
        'media_copy_failed',
      ];
      process.stdout.write(
        JSON.stringify({ error: safe.includes(error.message) ? error.message : 'media_copy_failed' }),
      );
    }); // filenames and filesystem errors remain private
}
