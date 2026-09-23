#!/usr/bin/env node
import assert from 'node:assert/strict';
import { main } from './engine.mjs';
assert.deepEqual(process.argv.slice(2), ['--check'], 'Usage: node studio/tools/feature-manifest.mjs --check');
await main(['verify']);
