const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { transformSync } = require('esbuild');

const compile = (path) =>
  transformSync(readFileSync(require.resolve(path), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'es2020',
  }).code;
const sdkCode = compile('../../plugin-sdk/src/sdk.ts');
const coreCode = compile('../src/index.ts');

const invoke = (method, value, config, asset = {}) => {
  let output;
  const Host = {
    inputString: () =>
      JSON.stringify({
        workflow: { authToken: 'fixture' },
        config,
        data: { asset: { originalFileName: value, originalPath: value, exifInfo: { make: value }, ...asset } },
      }),
    outputString: (text) => {
      output = text;
    },
  };
  const sdk = { exports: {} };
  runInNewContext(sdkCode, {
    module: sdk,
    exports: sdk.exports,
    Host,
    console: { error: () => {} },
    require: (name) => {
      assert.equal(name, 'src/host-functions.js');
      return { hostFunctions: () => ({}) };
    },
  });
  const core = { exports: {} };
  runInNewContext(coreCode, {
    module: core,
    exports: core.exports,
    require: (name) => {
      if (name === '@frameleaf/plugin-sdk') return sdk.exports;
      assert.equal(name, '@frameleaf/sdk');
      return { AssetVisibility: {} };
    },
  });
  core.exports[method]();
  return JSON.parse(output);
};

for (const method of ['assetFileFilter', 'assetExifFilter']) {
  for (const [value, pattern, expected] of [
    ['ABC', String.raw`^\D+$`, true],
    ['123', String.raw`^\D+$`, false],
    ['word', String.raw`^\W+$`, false],
    ['!!!', String.raw`^\W+$`, true],
    ['word', String.raw`^\S+$`, true],
    [' ', String.raw`^\S+$`, false],
  ]) {
    test(`${method} retains case-sensitive regex escapes: ${pattern} / ${value}`, () => {
      assert.deepEqual(invoke(method, value, { pattern, matchType: 'regex', property: 'make' }), {
        workflow: { continue: expected },
      });
    });
  }
  for (const [matchType, value, pattern, caseSensitive, expected] of [
    ['contains', 'FrameLeaf.jpg', 'leaf', false, true],
    ['contains', 'FrameLeaf.jpg', 'leaf', true, false],
    ['exact', 'ALPHA', 'alpha', false, true],
    ['exact', 'ALPHA', 'alpha', true, false],
    ['startsWith', 'ALPHA file', 'alpha', false, true],
    ['startsWith', 'ALPHA file', 'alpha', true, false],
    ['regex', 'Alpha', '^A.*$', true, true],
    ['regex', 'alpha', '^A.*$', true, false],
  ]) {
    test(`${method} ${matchType} caseSensitive=${caseSensitive} ${value}`, () => {
      assert.deepEqual(invoke(method, value, { pattern, matchType, caseSensitive, property: 'make' }), {
        workflow: { continue: expected },
      });
    });
  }
  test(`${method} preserves invalid-regex errors`, () => {
    assert.throws(() => invoke(method, 'value', { pattern: '[', matchType: 'regex', property: 'make' }), {
      name: 'SyntaxError',
    });
  });
  test(`${method} rejects non-string regex patterns`, () => {
    assert.throws(() => invoke(method, '42', { pattern: 42, matchType: 'regex', property: 'make' }), {
      name: 'TypeError',
    });
  });
}

test('numeric EXIF fields retain their string representation', () => {
  assert.deepEqual(invoke('assetExifFilter', 42, { pattern: '^42$', matchType: 'regex', property: 'make' }), {
    workflow: { continue: true },
  });
});

test('non-string file values cannot be coerced into regex matches', () => {
  assert.throws(() => invoke('assetFileFilter', 42, { pattern: '^42$', matchType: 'regex' }), { name: 'TypeError' });
});

for (const matching of ['any', 'all', 'none']) {
  for (const [assetTags, requested] of [
    [[], []],
    [['a'], []],
    [[], ['a']],
    [['a'], ['a']],
    [
      ['a', 'b'],
      ['a', 'c'],
    ],
    [
      ['a', 'a'],
      ['a', 'a'],
    ],
  ]) {
    test(`tag ${matching}: ${JSON.stringify(assetTags)} / ${JSON.stringify(requested)}`, () => {
      const matches = requested.map((tag) => assetTags.includes(tag));
      const expected =
        matching === 'any'
          ? matches.some(Boolean)
          : matching === 'all'
            ? matches.every(Boolean)
            : !matches.some(Boolean);
      assert.deepEqual(
        invoke(
          'assetTagFilter',
          '',
          { tags: requested, matching },
          {
            tags: assetTags.map((id) => ({ id })),
          },
        ),
        { workflow: { continue: expected } },
      );
    });
  }
}

test('tag matching handles large nonoverlapping lists', () => {
  const tags = Array.from({ length: 4000 }, (_, index) => ({ id: `asset-${index}` }));
  const requested = Array.from({ length: 4000 }, (_, index) => `requested-${index}`);
  assert.deepEqual(invoke('assetTagFilter', '', { tags: requested, matching: 'none' }, { tags }), {
    workflow: { continue: true },
  });
});

test('unknown tag matching modes retain the forward-compatible continuation default', () => {
  assert.deepEqual(invoke('assetTagFilter', '', { tags: ['a'], matching: 'future-mode' }, { tags: [{ id: 'a' }] }), {
    workflow: { continue: true },
  });
});
