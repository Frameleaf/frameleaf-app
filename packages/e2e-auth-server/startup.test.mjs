import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./startup.ts", import.meta.url),
  "utf8",
).replace(/^import setup from ['"]\.\/auth-server['"];?\r?\n/, "");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

for (const code of [0, 1]) {
  test(`cleans up without overwriting exit status ${code}`, async () => {
    const process = new EventEmitter();
    process.exitCode = code;
    process.exit = (status) => {
      process.exitCode = status;
    };
    let stopped = 0;
    const logs = [];
    await new AsyncFunction("setup", "process", "console", source)(
      async () => () => {
        stopped++;
      },
      process,
      { log: (message) => logs.push(message) },
    );
    process.emit("exit", code);
    assert.equal(process.exitCode, code);
    assert.equal(stopped, 1);
    assert.deepEqual(logs, ["[e2e-auth-server] stopped"]);
  });
}
