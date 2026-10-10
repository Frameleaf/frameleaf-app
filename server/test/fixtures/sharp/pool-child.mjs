// Only the pool fault tests load this fixture. Never imported by the production entrypoint.
process.on('SIGTERM', () => {});
process.on('disconnect', () => process.exit(0));
process.on('message', ({ id, args }) => {
  if (args[0] === 'hang') {
    process.send({ type: 'started', id });
    while (true) {} // Simulate a native call that will not return to JavaScript.
  }
  process.send({ type: 'result', id, value: { width: process.pid, height: 1, isTransparent: false } });
});
process.send({ type: 'ready' });
