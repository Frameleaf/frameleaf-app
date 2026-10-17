import { writeFile } from 'node:fs/promises';

// Only the pool fault tests load this fixture. Never imported by the production entrypoint.
process.on('SIGTERM', () => {});
process.on('disconnect', () => process.exit(0));
process.on('message', async ({ id, operation, args }) => {
  if (args[0] === 'hang') {
    process.send({ type: 'started', id });
    while (true) {} // Simulate a native call that will not return to JavaScript.
  }
  if (operation === 'generateHdrRenditions' || operation === 'exportPhotoStill') {
    const outputs = operation === 'generateHdrRenditions' ? args[1] : [{ path: args[1] }];
    for (const output of outputs) await writeFile(output.path, 'rendered fixture');
    process.send({ type: 'result', id, value: operation === 'generateHdrRenditions' ? outputs : undefined });
    return;
  }
  process.send({ type: 'result', id, value: { width: process.pid, height: 1, isTransparent: false } });
});
process.send({ type: 'ready' });
