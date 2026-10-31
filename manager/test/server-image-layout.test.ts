import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { test } from 'node:test';
import { SERVER_ADMIN } from '../src/docker.js';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

// Manager runs SERVER_ADMIN inside the released frameleaf-server image, so derive where the image puts it from
// server/Dockerfile's final (published) stage instead of trusting the string Manager sends.
test('SERVER_ADMIN matches where the final server image stage installs the admin wrapper', () => {
  const stages = read('server/Dockerfile').split(/^FROM\s/m);
  const final = stages.at(-1)!;
  let workdir = '/';
  let serverHome: string | undefined;
  for (const line of final.split('\n')) {
    const dir = /^WORKDIR\s+(\S+)/.exec(line);
    if (dir) workdir = posix.resolve(workdir, dir[1]);
    const copy = /^COPY\s+--from=server\s+\/output\/server-pruned\s+(\S+)/.exec(line);
    if (copy) serverHome = posix.resolve(workdir, copy[1]);
  }
  assert.ok(serverHome, 'final stage no longer copies /output/server-pruned');
  assert.equal(SERVER_ADMIN, posix.join(serverHome, 'bin/frameleaf-admin'));

  // The pruned deploy only ships package.json "files"; the wrapper must be in it and executable.
  assert.ok(JSON.parse(read('server/package.json')).files.includes('bin'));
  accessSync(new URL('server/bin/frameleaf-admin', root), constants.X_OK);
  assert.match(read('server/bin/frameleaf-admin'), /start\.sh frameleaf-admin "\$@"/);
  assert.match(read('server/bin/start.sh'), /SERVER_HOME="\$\(readlink -f "\$\(dirname "\$0"\)\/\.\."\)"/);
});
