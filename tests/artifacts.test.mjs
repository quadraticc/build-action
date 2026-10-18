import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepare, createBuild} from '../build/build.js';
import {run} from '../build/action.js';
import {values, env, acknowledgement} from './fixtures.mjs';

const images = {web: `123456789012.dkr.ecr.us-east-1.amazonaws.com/web@sha256:${'b'.repeat(64)}`, migrations: `123456789012.dkr.ecr.us-east-1.amazonaws.com/migrations@sha256:${'c'.repeat(64)}`};
const metadata = {migration_name: '20261018_Initial'};
const inputs = {...values, 'image-reference': '', images: JSON.stringify(images), metadata: JSON.stringify(metadata)};

test('named images and metadata are acknowledged and exposed without redundant legacy fields', async () => {
  const result = await createBuild(inputs, env, async (_url, _token, body) => {
    const payload = JSON.parse(body);
    assert.deepEqual(payload.images, images);
    assert.deepEqual(payload.metadata, metadata);
    assert.equal(payload.image_reference, undefined);
    return acknowledgement(payload);
  });
  assert.deepEqual(result.images, images);
  assert.deepEqual(result.metadata, metadata);
  assert.equal(result.branch, 'main');
  const outputs = {};
  await run({getInput(name) {return inputs[name] || '';}, setSecret() {}, setOutput(name, value) {outputs[name] = value;}, info() {}, setFailed(message) {assert.fail(message);}}, env, async (_url, _token, body) => acknowledgement(JSON.parse(body)));
  assert.deepEqual(JSON.parse(outputs.images), images);
  assert.deepEqual(JSON.parse(outputs.metadata), metadata);
});

test('invalid or unbounded artifact maps fail before a request and omit private input contents', async () => {
  for (const change of [
    {images: 'not-private-json'}, {images: 'null'}, {images: '[]'}, {images: '{"web":42}'},
    {images: '{"web":"private-tag:latest"}'}, {images: JSON.stringify({'../private': images.web})},
    {images: JSON.stringify({web: `https://private/image@sha256:${'b'.repeat(64)}`})},
    {images: JSON.stringify({web: `ghcr.io/private/image@sha256:${'z'.repeat(64)}`})},
    {images: JSON.stringify(Object.fromEntries(Array.from({length: 17}, (_, i) => ['image' + i, images.web])))},
    {metadata: '["private"]'}, {metadata: '{"field":42}'}, {metadata: JSON.stringify({'private key': 'value'})},
    {metadata: JSON.stringify({field: 'x'.repeat(4097)})}, {metadata: JSON.stringify({field: '\0private'})},
    {metadata: JSON.stringify({a: 'x'.repeat(4096), b: 'x'.repeat(4096), c: 'x'.repeat(4096)})},
    {'image-reference': 'private-conflicting-image'},
  ]) {
    let calls = 0;
    await assert.rejects(createBuild({...inputs, ...change}, env, async () => {calls++; throw new Error('unexpected request');}), error => !error.message.includes('private'));
    assert.equal(calls, 0);
  }
});

test('artifact acknowledgement compares map contents independent of key order and rejects missing or changed metadata', async () => {
  await createBuild(inputs, env, async (_url, _token, body) => acknowledgement(JSON.parse(body), 200, {images: {migrations: images.migrations, web: images.web}}));
  for (const change of [{images: {}}, {images: null}, {images: []}, {metadata: {}}, {metadata: {migration_name: 'other'}}, {images: {...images, extra: images.web}}]) {
    await assert.rejects(createBuild(inputs, env, async (_url, _token, body) => acknowledgement(JSON.parse(body), 201, change)), /mismatched build acknowledgement/);
  }
  assert.deepEqual(prepare(values, env).payload.images, JSON.parse(values.images));
});
