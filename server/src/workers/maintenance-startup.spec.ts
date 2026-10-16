import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile(
  'maintenance.ts',
  readFileSync(new URL('maintenance.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const bootstrap = source.statements.find(
  (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'bootstrap',
)!;
const { outputText } = ts.transpileModule(bootstrap.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
});

// Run the actual entrypoint body without starting its worker or touching process exit handlers.
const start = (configureExpress: () => Promise<void>): Promise<void> =>
  runInNewContext(`${outputText}\nbootstrap()`, {
    NestFactory: { create: () => Promise.resolve({ getHttpServer: () => ({}), get: () => ({ setCloseFn() {} }) }) },
    MaintenanceModule: class {},
    MaintenanceWorkerService: class {},
    AppRepository: class {},
    HttpRequestTracker: class {},
    configureExpress,
    onStopRequest() {},
    closeGracefully() {},
    process: {},
  }) as Promise<void>;

it('keeps maintenance startup pending until Express finishes listening', async () => {
  const ready = Promise.withResolvers<void>();
  let settled = false;
  const starting = start(() => ready.promise).then(() => {
    settled = true;
  });
  try {
    await setImmediate();
    expect(settled).toBe(false);
  } finally {
    ready.resolve();
    await starting;
  }
});

it('passes Express startup failures back to the entrypoint error handler', async () => {
  const failure = new Error('Listen failed');
  const configured = Promise.reject<void>(failure);
  void configured.catch(() => {});
  await expect(start(() => configured)).rejects.toBe(failure);
});
