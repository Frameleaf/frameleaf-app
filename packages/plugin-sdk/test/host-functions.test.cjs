const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { runInNewContext } = require("node:vm");
const { transformSync } = require("esbuild");

const code = transformSync(
  readFileSync(require.resolve("../src/host-functions.ts"), "utf8"),
  { loader: "ts", format: "cjs", target: "es2020" },
).code;

const setup = ({
  fail,
  reply = '{"success":true,"response":{"ok":true}}',
} = {}) => {
  const freed = [];
  const calls = [];
  let payload;
  const input = { offset: 1n, free: () => freed.push("input") };
  const output = {
    readString: () => {
      if (fail === "read") throw new Error("read failed");
      return reply;
    },
    free: () => {
      freed.push("output");
      if (fail === "free") throw new Error("free failed");
    },
  };
  const module = { exports: {} };
  runInNewContext(code, {
    exports: module.exports,
    module,
    Host: {
      getFunctions: () =>
        Object.fromEntries(
          [
            "searchAlbums",
            "createAlbum",
            "addAssetsToAlbum",
            "addAssetsToAlbums",
            "httpRequest",
            "bulkTagAssets",
          ].map((name) => [
            name,
            (offset) => {
              assert.equal(offset, input.offset);
              calls.push(name);
              if (fail === "call") throw new Error("call failed");
              return 2n;
            },
          ]),
        ),
    },
    Memory: {
      fromString: (value) => {
        payload = JSON.parse(value);
        return input;
      },
      find: (offset) => {
        assert.equal(offset, 2n);
        if (fail === "find") throw new Error("find failed");
        return output;
      },
    },
  });
  return {
    functions: module.exports.hostFunctions("test-token"),
    payload: () => payload,
    freed,
    calls,
  };
};

const wrappers = [
  ["searchAlbums", [{ shared: true }], [{ shared: true }]],
  ["createAlbum", [{ albumName: "album" }], [{ albumName: "album" }]],
  ["addAssetsToAlbum", ["album", ["asset"]], ["album", { ids: ["asset"] }]],
  [
    "addAssetsToAlbums",
    [{ albumIds: ["album"], assetIds: ["asset"] }],
    [{ albumIds: ["album"], assetIds: ["asset"] }],
  ],
  [
    "httpRequest",
    ["https://example.test", { method: "POST", body: "test" }],
    ["https://example.test", { method: "POST", body: "test" }],
  ],
  [
    "bulkTagAssets",
    [{ tagIds: ["tag"], assetIds: ["asset"] }],
    [{ tagIds: ["tag"], assetIds: ["asset"] }],
  ],
];

for (const [name, args, expected] of wrappers) {
  test(`${name} preserves the host payload and frees both blocks`, () => {
    const run = setup();
    assert.equal(run.functions[name](...args).ok, true);
    assert.deepEqual(run.payload(), {
      authToken: "test-token",
      args: expected,
    });
    assert.deepEqual(run.calls, [name]);
    assert.deepEqual(run.freed, ["output", "input"]);
  });
}

for (const fail of ["call", "find", "read", "free"]) {
  test(`frees every acquired block when ${fail} fails`, () => {
    const run = setup({ fail });
    assert.throws(() => run.functions.searchAlbums({}), {
      message: `${fail} failed`,
    });
    assert.deepEqual(
      run.freed,
      fail === "call" || fail === "find" ? ["input"] : ["output", "input"],
    );
  });
}

test("frees both blocks when response JSON is malformed", () => {
  const run = setup({ reply: "{" });
  assert.throws(() => run.functions.searchAlbums({}), { name: "SyntaxError" });
  assert.deepEqual(run.freed, ["output", "input"]);
});

test("preserves structured host error details and frees both blocks", () => {
  const run = setup({
    reply: '{"success":false,"status":403,"message":{"reason":"denied"}}',
  });
  assert.throws(() => run.functions.searchAlbums({}), {
    message:
      'Failed to call host function "searchAlbums", received 403 - {"reason":"denied"}',
  });
  assert.deepEqual(run.freed, ["output", "input"]);
});
