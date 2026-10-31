const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { runInNewContext } = require("node:vm");
const { transformSync } = require("esbuild");

const code = transformSync(
  readFileSync(require.resolve("../src/sdk.ts"), "utf8"),
  {
    loader: "ts",
    format: "cjs",
    target: "es2020",
  },
).code;

const invoke = (method, config = {}) => {
  const logs = [];
  let output;
  let token;
  const module = { exports: {} };
  runInNewContext(code, {
    exports: module.exports,
    module,
    require: (name) => {
      assert.equal(name, "src/host-functions.js");
      return {
        hostFunctions: (authToken) => {
          token = authToken;
          return { marker: true };
        },
      };
    },
    Host: {
      inputString: () =>
        JSON.stringify({
          config,
          workflow: { authToken: "private-token" },
          type: "AssetV1",
          trigger: "AssetCreate",
        }),
      outputString: (value) => {
        output = value;
      },
    },
    console: Object.fromEntries(
      ["debug", "error"].map((level) => [
        level,
        (...args) => logs.push(args.join(" ")),
      ]),
    ),
  });
  const call = () => module.exports.wrapper({ inspect: method }).inspect();
  return { call, logs, output: () => JSON.parse(output), token: () => token };
};

test("passes host functions and emits an unchanged response once", () => {
  const run = invoke(({ functions }) => {
    assert.equal(functions.marker, true);
    return { data: { result: 2 } };
  });
  run.call();
  assert.equal(run.token(), "private-token");
  assert.deepEqual(run.output(), { data: { result: 2 } });
});

test("reports implicit nested config changes even when the method returns nothing", () => {
  const run = invoke(
    ({ config }) => {
      config.nested.enabled = true;
    },
    { nested: { enabled: false } },
  );
  run.call();
  assert.deepEqual(run.output(), { config: { nested: { enabled: true } } });
});

test("does not return unchanged config unnecessarily", () => {
  const run = invoke(() => undefined, { enabled: true });
  run.call();
  assert.deepEqual(run.output(), {});
});

test("an explicit replacement config wins over nonserializable discarded mutations", () => {
  const run = invoke(({ config }) => {
    config.self = config;
    return { config: { replacement: true } };
  });
  run.call();
  assert.deepEqual(run.output(), { config: { replacement: true } });
});

test("does not copy private config or response fields into SDK logs", () => {
  const run = invoke(() => ({ data: { secret: "private-result" } }), {
    secret: "private-config",
  });
  run.call();
  assert.doesNotMatch(run.logs.join("\n"), /private-(?:token|config|result)/);
  assert.deepEqual(run.output(), { data: { secret: "private-result" } });
});

test("rethrows the original plugin exception without duplicating its contents in logs", () => {
  const error = new Error("private-token");
  const run = invoke(() => {
    throw error;
  });
  assert.throws(run.call, (actual) => actual === error);
  assert.doesNotMatch(run.logs.join("\n"), /private-token/);
  assert.ok(run.logs.length > 0);
});
