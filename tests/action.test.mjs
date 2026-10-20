import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run} from '../build/action.js';
import {values, env, acknowledgement} from './fixtures.mjs';

function toolkit(inputs = values) {
  const events = [], outputs = new Map(), errors = [];
  return {events, outputs, errors,
    getInput(name, options) { assert.equal(options.trimWhitespace, false); return inputs[name] ?? ''; },
    setSecret(secret) {events.push(['mask', secret]);},
    setOutput(name, value) {events.push(['output', name]); outputs.set(name, value);},
    setFailed(message) {events.push(['failure']); errors.push(message);},
    info(message) {events.push(['info', message]);},
  };
}

test('token masking precedes the only request, and validated results become action outputs', async () => {
  const core = toolkit();
  await run(core, env, async (_url, token, body) => {
    assert.equal(token, values.token);
    assert.deepEqual(core.events, [['mask', token]]);
    core.events.push(['request']);
    return acknowledgement(JSON.parse(body), 200);
  });
  assert.deepEqual(core.errors, []);
  assert.equal(core.outputs.get('created'), 'false');
  assert.equal(core.outputs.get('version'), '0.0.7');
  assert.equal(core.outputs.get('commit-sha'), env.GITHUB_SHA);
  assert.equal(core.outputs.size, 9);
  assert.ok(!JSON.stringify(core.events.slice(1)).includes(values.token));
});

test('invalid inputs fail before networking and publish no outputs', async () => {
  const core = toolkit({...values, token: 'private invalid token'});
  let calls = 0;
  await run(core, env, async () => {calls++; throw new Error('should not send');});
  assert.equal(calls, 0);
  assert.equal(core.outputs.size, 0);
  assert.deepEqual(core.events[0], ['mask', 'private invalid token']);
  assert.equal(core.errors.length, 1);
  assert.ok(!core.errors[0].includes('private invalid token'));
});

test('unexpected client errors and untrusted acknowledgements never reveal their contents or publish partial results', async () => {
  for (const send of [
    async () => {throw new Error('private transport details ' + values.token);},
    async () => ({status: 201, contentType: 'application/json', body: JSON.stringify({id: 'private ' + values.token})}),
  ]) {
    const core = toolkit();
    await run(core, env, send);
    assert.equal(core.errors.length, 1);
    assert.ok(!core.errors[0].includes(values.token));
    assert.ok(!core.errors[0].includes('private transport'));
    assert.equal(core.outputs.size, 0);
  }
});
