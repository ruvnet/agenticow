import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pkg from '@ruvector/rvf-node';

const require = createRequire(import.meta.url);
const own = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const rvfNode = require('@ruvector/rvf-node/package.json');

// agenticow must track the current rvf-node line. A zero-major caret such as
// ^0.2.0 means >=0.2.0 <0.3.0, so it silently excluded 0.3.x and 0.4.x.
test('declared @ruvector/rvf-node range admits the 0.4 line', () => {
  // ^0.4.3: durable per-vector metadata, forceExact, file metadata.
  assert.match(own.dependencies['@ruvector/rvf-node'], /^\^0\.4\.([3-9]|\d\d)/);
  const [major, minor] = rvfNode.version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 4, `resolved rvf-node ${rvfNode.version} is older than 0.4`);
});

// Every RvfDatabase member that src/, bin/ and bench/ call.
test('RvfDatabase exposes every member agenticow calls', () => {
  const { RvfDatabase } = pkg;
  for (const fn of ['create', 'open', 'openReadonly']) {
    assert.equal(typeof RvfDatabase[fn], 'function', `RvfDatabase.${fn}`);
  }
  for (const fn of ['fileId', 'dimension', 'metric', 'derive', 'branch', 'ingestBatch',
    'query', 'delete', 'status', 'close',
    // feature-checked in src/, present from rvf-node 0.4.2
    'ingestBatchWithMetadata', 'getMetadata', 'getFileMetadata', 'setFileMetadata']) {
    assert.equal(typeof RvfDatabase.prototype[fn], 'function', `RvfDatabase#${fn}`);
  }
});
