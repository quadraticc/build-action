import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'yaml';
import {run} from '../build/action.js';
import {values, env, acknowledgement} from './fixtures.mjs';

test('published action metadata matches runtime inputs, outputs and packaged entry point', async t => {
  const metadata = parse(readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
  assert.equal(metadata.runs.using, 'node24');
  assert.ok(existsSync(new URL(`../${metadata.runs.main}`, import.meta.url)));
  const read = new Set(), written = new Set();
  await run({
    getInput(name) {read.add(name); return values[name] ?? '';},
    setSecret() {}, setOutput(name) {written.add(name);}, info() {},
    setFailed(message) {assert.fail(message);},
  }, env, async (_url, _token, body) => acknowledgement(JSON.parse(body)));
  const directory = await mkdtemp(join(tmpdir(), 'quadraticc-interface-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = join(directory, 'report.xml');
  await writeFile(file, '<testsuite/>');
  const upload = {...values, 'version-prefix': '', images: '', 'test-results-file': file};
  await run({
    getInput(name) {read.add(name); return upload[name] ?? '';},
    setSecret() {}, setOutput(name) {written.add(name);}, info() {},
    setFailed(message) {assert.fail(message);},
  }, env, async () => ({status: 201, contentType: 'application/json', body: JSON.stringify({
    id: values['project-id'], total: 0, passed: 0, failed: 0, errors: 0, skipped: 0,
  })}));
  assert.deepEqual([...read].sort(), Object.keys(metadata.inputs).sort());
  assert.deepEqual([...written].sort(), Object.keys(metadata.outputs).sort());
  for (const name of ['token', 'workspace-id', 'project-id']) assert.equal(metadata.inputs[name].required, true);
  assert.equal(metadata.inputs.url.default, 'https://app.quadrati.cc');
  assert.notEqual(metadata.inputs.url.required, true);
  for (const path of ['../.github/workflows/check.yml', '../.github/dependabot.yml']) {
    const document = parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
    assert.ok(document && typeof document === 'object');
  }
});
