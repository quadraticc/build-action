import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, truncate, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {uploadTestResults} from '../build/reports.js';
import {run} from '../build/action.js';
import {ActionError} from '../build/http.js';
import {values, env, buildID} from './fixtures.mjs';

const receipt = {id: buildID, total: 4, passed: 1, failed: 1, errors: 1, skipped: 1};
const reply = (status = 201, data = receipt) => ({status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(data)});
async function report(t, content = '<testsuite><testcase name="works"/></testsuite>') {
  const directory = await mkdtemp(join(tmpdir(), 'quadraticc-reports-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'results.xml');
  await writeFile(path, content);
  const {'version-prefix': _version, images: _images, ...base} = values;
  return {...base, 'test-results-file': path};
}

test('JUnit and TRX reports upload independently of builds with original XML and runner provenance', async t => {
  const xml = '\uFEFF<testsuite name="é &amp; 😀">\r\n<testcase name="&quot;test&quot;"/>\n</testsuite>';
  const inputs = await report(t, xml);
  for (const format of ['junit', 'trx']) {
    let calls = 0;
    const result = await uploadTestResults({...inputs, 'test-results-format': format, 'link-workflow-run': 'true'}, env, async (url, token, body) => {
      calls++;
      assert.equal(url.pathname, `/api/v1/workspaces/${values['workspace-id']}/projects/${values['project-id']}/test-results`);
      assert.equal(token, values.token);
      assert.deepEqual(JSON.parse(body), {upload_id: '123/1/results.xml', filename: 'results.xml', format,
        branch: 'main', commit_sha: env.GITHUB_SHA, report: xml, workflow_run: {repository_id: 42, run_id: 123}});
      return reply();
    });
    assert.deepEqual(result, receipt);
    assert.equal(calls, 1);
  }
});

test('uploads support explicit identity and Quadraticc workflow IDs outside GitHub, and exact replay receipts', async t => {
  const inputs = await report(t);
  for (const status of [200, 201]) {
    const result = await uploadTestResults({...inputs, 'test-results-upload-id': 'execution/attempt/file', branch: 'feature/test',
      'commit-sha': 'B'.repeat(64), 'workflow-run-id': 'ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF'}, {}, async (_url, _token, body) => {
      const payload = JSON.parse(body);
      assert.equal(payload.upload_id, 'execution/attempt/file');
      assert.equal(payload.workflow_run_id, 'abcdefab-abcd-abcd-abcd-abcdefabcdef');
      assert.equal(payload.workflow_run, undefined);
      assert.equal(payload.branch, 'feature/test');
      assert.equal(payload.commit_sha, 'B'.repeat(64));
      return reply(status, {...receipt, private: 'untrusted provider content'});
    });
    assert.deepEqual(result, receipt);
  }
});

test('upload retry IDs distinguish attempts and permit explicit keys for duplicate basenames', async t => {
  const inputs = await report(t);
  for (const [changes, context, expected] of [
    [{}, {...env, GITHUB_RUN_ATTEMPT: '2'}, '123/2/results.xml'],
    [{'test-results-upload-id': 'linux/unit'}, env, 'linux/unit'],
    [{'test-results-upload-id': 'x'.repeat(200)}, env, 'x'.repeat(200)],
  ]) await uploadTestResults({...inputs, ...changes}, context, async (_url, _token, body) => {
    assert.equal(JSON.parse(body).upload_id, expected);
    return reply();
  });
});

test('invalid upload inputs fail before networking without disclosing supplied values', async t => {
  const inputs = await report(t);
  for (const changes of [
    {url: 'http://private.example'}, {token: 'private'}, {'workspace-id': 'private'}, {'project-id': 'private'},
    {version: '1.2.3'}, {'version-prefix': '0.0.'}, {'version-suffix': '-test'}, {images: '{}'}, {metadata: '{}'},
    {'build-id': buildID}, {'is-release': 'true'}, {'is-release': 'private'},
    {'test-results-format': 'private'}, {'test-results-upload-id': 'x'.repeat(201)},
    {'test-results-upload-id': 'private\n'}, {'test-results-upload-id': '\ud800'},
    {'test-results-upload-id': '😀'.repeat(51)}, {'commit-sha': 'private'}, {branch: 'private\n'},
    {'workflow-run-id': 'private'}, {'workflow-run-id': buildID, 'link-workflow-run': 'true'},
    {'link-workflow-run': 'private'}, {'test-results-file': join(inputs['test-results-file'], 'x'.repeat(256))},
    {'test-results-file': join(inputs['test-results-file'], 'private\\name')},
  ]) {
    let calls = 0;
    await assert.rejects(uploadTestResults({...inputs, ...changes}, env, async () => {calls++;}), error => {
      assert.ok(error instanceof ActionError);
      assert.ok(!error.message.includes('private'));
      assert.ok(!error.message.includes(values.token));
      return true;
    });
    assert.equal(calls, 0);
  }
  for (const context of [{}, {...env, GITHUB_RUN_ID: 'bad'}, {...env, GITHUB_RUN_ATTEMPT: ''},
    {...env, GITHUB_REF_NAME: ''}, {...env, GITHUB_REPOSITORY_ID: '', GITHUB_SERVER_URL: 'https://github.com'}]) {
    await assert.rejects(uploadTestResults({...inputs, 'link-workflow-run': 'true'}, context, async () => assert.fail('unexpected request')), ActionError);
  }
});

test('missing, empty, invalid UTF-8, non-file and oversized reports fail before networking', async t => {
  const inputs = await report(t);
  const path = inputs['test-results-file'];
  for (const content of ['', Buffer.from([0xc3, 0x28])]) {
    await writeFile(path, content);
    await assert.rejects(uploadTestResults(inputs, env, async () => assert.fail('unexpected request')), /readable, nonempty UTF-8/);
  }
  await truncate(path, 8 * 1024 * 1024 + 1);
  await assert.rejects(uploadTestResults(inputs, env, async () => assert.fail('unexpected request')), /at most 8 MiB/);
  await rm(path);
  await assert.rejects(uploadTestResults(inputs, env, async () => assert.fail('unexpected request')), /readable/);
  await mkdir(path);
  await assert.rejects(uploadTestResults(inputs, env, async () => assert.fail('unexpected request')), /readable/);
});

test('the 8 MiB XML limit is separate from the build JSON limit and allows JSON escaping overhead', async t => {
  const content = '"'.repeat(8 * 1024 * 1024);
  const inputs = await report(t, content);
  await uploadTestResults(inputs, env, async (_url, _token, body) => {
    assert.ok(Buffer.byteLength(body) > 8 * 1024 * 1024);
    assert.equal(JSON.parse(body).report, content);
    return reply(201, {id: buildID, total: 0, passed: 0, failed: 0, errors: 0, skipped: 0});
  });
});

test('failed requests make one attempt and omit provider bodies and secrets', async t => {
  const inputs = await report(t);
  for (const status of [204, 301, 302, 307, 308, 400, 401, 403, 404, 409, 413, 415, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(uploadTestResults(inputs, env, async () => {
      calls++;
      return {status, contentType: 'text/plain', body: `private ${values.token}`};
    }), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes('private'));
      assert.ok(!error.message.includes(values.token));
      return true;
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(uploadTestResults(inputs, env, async () => {calls++; throw new ActionError('interrupted');}), /interrupted/);
  assert.equal(calls, 1);
});

test('invalid receipts never publish outputs; masking precedes uploads and only validated receipt fields are emitted', async t => {
  const inputs = await report(t);
  const replies = [reply(), reply(200),
    ...[null, [], {}, {...receipt, id: 'private'}, {...receipt, total: 5}, {...receipt, passed: -1},
      {...receipt, failed: 1.5}, {...receipt, errors: '1'}, {...receipt, skipped: null},
      {...receipt, total: 10001, passed: 9998}, {...receipt, skipped: undefined}].map(data => reply(201, data)),
    {status: 201, contentType: 'text/html', body: 'private'},
    {status: 201, contentType: 'application/json', body: 'private'},
  ];
  for (let i = 0; i < replies.length; i++) {
    const outputs = {}, errors = [], events = [];
    await run({getInput(name) {return inputs[name] || '';}, setSecret(token) {events.push(['mask', token]);},
      setOutput(name, value) {outputs[name] = value;}, info() {}, setFailed(message) {errors.push(message);}}, env,
    async () => {assert.deepEqual(events, [['mask', values.token]]); return replies[i];});
    if (i < 2) {
      assert.deepEqual(errors, []);
      assert.deepEqual(outputs, {'test-report-id': buildID, 'test-results': JSON.stringify(receipt)});
    } else {
      assert.deepEqual(outputs, {});
      assert.equal(errors.length, 1);
      assert.match(errors[0], /invalid test report receipt/);
      assert.ok(!errors[0].includes('private'));
    }
  }
});

test('test-specific options cannot silently fall through to build registration', async () => {
  for (const options of [{'workflow-run-id': buildID}, {'test-results-upload-id': 'key'}, {'test-results-format': 'trx'}]) {
    const errors = [];
    await run({getInput(name) {return {...values, ...options}[name] || '';}, setSecret() {},
      setOutput() {assert.fail('unexpected output');}, info() {}, setFailed(message) {errors.push(message);}}, env,
    async () => assert.fail('unexpected request'));
    assert.match(errors[0], /require test-results-file/);
  }
});
