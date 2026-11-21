import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../greet.js';

test('greet says hello to the world', () => {
  assert.equal(greet(), 'Hello, world!');
});
