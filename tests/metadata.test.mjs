import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {parse} from 'yaml';
import {run} from '../build/action.js';
import {values, env, acknowledgement} from './fixtures.mjs';

test('published action metadata matches runtime inputs, outputs and packaged entry point', async () => {
  const metadata = parse(readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
  assert.equal(metadata.runs.using, 'node24');
  assert.ok(existsSync(new URL(`../${metadata.runs.main}`, import.meta.url)));
  const read = new Set(), written = new Set();
  await run({
    getInput(name) {read.add(name); return values[name] ?? '';},
    setSecret() {}, setOutput(name) {written.add(name);}, info() {},
    setFailed(message) {assert.fail(message);},
  }, env, async (_url, _token, body) => acknowledgement(JSON.parse(body)));
  assert.deepEqual([...read].sort(), Object.keys(metadata.inputs).sort());
  assert.deepEqual([...written].sort(), Object.keys(metadata.outputs).sort());
  for (const name of ['url', 'token', 'workspace-id', 'project-id']) assert.equal(metadata.inputs[name].required, true);
  for (const path of ['../.github/workflows/check.yml', '../.github/dependabot.yml']) {
    const document = parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
    assert.ok(document && typeof document === 'object');
  }
});
