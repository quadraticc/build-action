import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepare, createBuild} from '../build/build.js';
import {ActionError} from '../build/http.js';
import {values, env, buildID, acknowledgement} from './fixtures.mjs';

test('numbering is allocated by one POST to the project API, with the exact artifact commit and image', async () => {
  let calls = 0;
  const result = await createBuild({...values, url: 'https://app.quadrati.cc/'}, env, async (url, token, body) => {
    calls++;
    assert.equal(url.href, `https://app.quadrati.cc/api/v1/workspaces/${values['workspace-id']}/projects/${values['project-id']}/builds/next`);
    assert.equal(token, values.token);
    const payload = JSON.parse(body);
    assert.deepEqual(payload, {version_prefix: '0.0.', commit_sha: env.GITHUB_SHA,
      branch: 'main', images: JSON.parse(values.images)});
    return acknowledgement(payload);
  });
  assert.equal(calls, 1);
  assert.equal(result.id, buildID);
  assert.equal(result.version, '0.0.7');
  assert.equal(result.created, true);
  assert.equal(result.url, `https://app.quadrati.cc/app/workspaces/${values['workspace-id']}/projects/${values['project-id']}/builds?build=${buildID}`);
});

test('explicit semantic versions preserve branch and full commits', async () => {
  const input = {...values, version: '1.2.3-rc.1+build.42', 'version-prefix': '', 'commit-sha': 'B'.repeat(64), branch: 'feature/builds'};
  const result = await createBuild(input, env, async (url, _token, body) => {
    assert.ok(url.pathname.endsWith('/builds'));
    const payload = JSON.parse(body);
    assert.equal(payload.version, input.version);
    assert.equal(payload.version_prefix, undefined);
    assert.equal(payload.commit_sha, 'B'.repeat(64));
    assert.equal(payload.branch, 'feature/builds');
    return acknowledgement(payload);
  });
  assert.equal(result.branch, 'feature/builds');
  assert.equal(result.commit, 'B'.repeat(64));
});

test('numbered exact replay exposes created=false and does not perform any retrieval', async () => {
  let calls = 0;
  const result = await createBuild(values, env, async (_url, _token, body) => {
    calls++;
    return acknowledgement(JSON.parse(body), 200);
  });
  assert.equal(result.created, false);
  assert.equal(calls, 1);
});

test('semantic suffixes and explicit metadata survive numbered registration', async () => {
  const input = {...values, 'version-suffix': '-' + env.GITHUB_SHA, metadata: '{"ci_run":"123","ci_attempt":"2"}'};
  const result = await createBuild(input, env, async (_url, _token, body) => {
    const payload = JSON.parse(body);
    assert.equal(payload.version_suffix, '-' + env.GITHUB_SHA);
    assert.deepEqual(payload.metadata, {ci_run: '123', ci_attempt: '2'});
    return acknowledgement(payload);
  });
  assert.equal(result.version, '0.0.7-' + env.GITHUB_SHA);
  for (const version of ['v1.2.3', '1.2', '01.2.3', '1.2.3-01', '1.2.3-', '1.2.3+'])
    assert.throws(() => prepare({...values, version, 'version-prefix': ''}, env), ActionError);
  for (const suffix of ['abc', '-01', '+', '-'])
    assert.throws(() => prepare({...values, 'version-suffix': suffix}, env), ActionError);
});

test('plain registration needs no GitHub App, GitHub token or repository/run identity', async () => {
  const input = {...values, 'commit-sha': env.GITHUB_SHA};
  const prepared = prepare(input, {});
  assert.equal(prepared.payload.workflow_run, undefined);
  assert.equal(prepared.payload.build_notes, undefined);
  const result = await createBuild(input, {}, async (_url, _token, body) => acknowledgement(JSON.parse(body)));
  assert.equal(result.version, '0.0.7');
});

test('workflow association is explicitly opt-in and uses this GitHub.com repository/run context', async () => {
  const result = await createBuild({...values, 'link-workflow-run': 'true'}, env, async (_url, _token, body) => {
    const payload = JSON.parse(body);
    assert.deepEqual(payload.workflow_run, {repository_id: 42, run_id: 123});
    return acknowledgement(payload);
  });
  assert.equal(result.created, true);
  for (const context of [
    {...env, GITHUB_REPOSITORY_ID: ''}, {...env, GITHUB_RUN_ID: '-1'},
    {...env, GITHUB_REPOSITORY_ID: '9007199254740992'}, {...env, GITHUB_SERVER_URL: 'https://ghe.example.com'},
  ]) assert.throws(() => prepare({...values, 'link-workflow-run': 'true'}, context), ActionError);
});

test('unsafe or invalid inputs fail without making a network request or reflecting their contents', async t => {
  const cases = [
    {url: ''}, {url: 'http://app.quadrati.cc'}, {url: 'https://user:private@app.quadrati.cc'},
    {url: 'https://app.quadrati.cc/project'}, {url: 'https://app.quadrati.cc?secret=private'},
    {url: 'https://app.quadrati.cc#private'}, {url: 'https://app.quadrati.cc?'}, {url: 'https://app.quadrati.cc#'},
    {url: 'https://app.quadrati.cc\\@other.example'}, {url: 'https://app.quadrati.cc\n'},
    {url: ' https://app.quadrati.cc'}, {'workspace-id': '../private'}, {'project-id': 'not-a-uuid'},
    {token: ''}, {token: values.token + '\n'}, {token: 'Bearer private-token'},
    {'version-prefix': ''}, {version: '1.2.3'}, {'version-prefix': '0.01.'}, {'version-prefix': '1.2'},
    {'version-prefix': '1'.repeat(100) + '.2.'}, {'commit-sha': 'abc'}, {'commit-sha': 'g'.repeat(40)},
    {version: ' private ', 'version-prefix': ''}, {version: 'x\u0085private', 'version-prefix': ''},
    {version: '😀'.repeat(26), 'version-prefix': ''}, {version: '\ud800', 'version-prefix': ''},
    {'image-reference': 'x\nprivate'}, {'image-reference': '😀'.repeat(513)},
    {'build-notes': 'x\0private'}, {'build-notes': '😀'.repeat(4097)},
    {'build-notes': '\n'.repeat(16384)}, {'link-workflow-run': 'yes'},
  ];
  for (let i = 0; i < cases.length; i++) await t.test(`invalid input ${i + 1}`, async () => {
    let calls = 0;
    await assert.rejects(createBuild({...values, ...cases[i]}, env, async () => {calls++; throw new Error('unexpected request');}), error => {
      assert.ok(error instanceof ActionError);
      assert.ok(!error.message.includes('private'));
      assert.ok(!error.message.includes(values.token));
      return true;
    });
    assert.equal(calls, 0);
  });
});

test('UUID case is normalized and optional branch and metadata can be absent', () => {
  const input = {...values, version: '1.2.3', 'version-prefix': '',
    'workspace-id': 'ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF', images: ''};
  const prepared = prepare(input, {'GITHUB_SHA': env.GITHUB_SHA});
  assert.ok(prepared.endpoint.pathname.includes('abcdefab-abcd-abcd-abcd-abcdefabcdef'));
  assert.equal(prepared.payload.branch, undefined);
  assert.equal(prepared.payload.images, undefined);
});

test('HTTP failures remain failures, including explicit conflicts and redirects; provider text stays private', async t => {
  for (const status of [200, 204, 301, 302, 303, 307, 308, 400, 401, 403, 404, 409, 415, 429, 500, 503]) {
    await t.test(`HTTP ${status}`, async () => {
      let calls = 0;
      await assert.rejects(createBuild({...values, version: '1.2.3', 'version-prefix': ''}, env, async () => {
        calls++;
        return {status, contentType: 'text/plain', body: 'private-provider-output ' + values.token};
      }), error => {
        assert.ok(error.message.includes(`HTTP ${status}`));
        assert.ok(!error.message.includes('private-provider-output'));
        assert.ok(!error.message.includes(values.token));
        return true;
      });
      assert.equal(calls, 1);
    });
  }
});

test('a successful status must acknowledge exactly the submitted metadata and expected version series', async t => {
  const changes = [
    {id: 'invalid'}, {version: '9.9.9'}, {version: '0.0.01'}, {version: '0.0.1\nprivate'},
    {commit_sha: 'b'.repeat(40)}, {branch: 'other'}, {image_reference: 'other-image'}, {build_notes: 'private notes'},
    {created_at: 'invalid'}, {workflow_run: {repository_id: 42, run_id: 123}},
  ];
  for (let i = 0; i < changes.length; i++) await t.test(`mismatch ${i + 1}`, async () => {
    await assert.rejects(createBuild(values, env, async (_url, _token, body) => acknowledgement(JSON.parse(body), 201, changes[i])), /mismatched build acknowledgement/);
  });
  for (const reply of [
    {status: 201, contentType: 'text/html', body: '<h1>private output</h1>'},
    {status: 201, contentType: 'application/json', body: 'private invalid JSON'},
    {status: 201, contentType: 'application/json', body: '[]'},
    {status: 201, contentType: 'application/json', body: 'null'},
  ]) await assert.rejects(createBuild(values, env, async () => reply), /mismatched build acknowledgement/);
  await assert.rejects(createBuild({...values, 'link-workflow-run': 'true'}, env,
    async (_url, _token, body) => acknowledgement(JSON.parse(body), 201, {workflow_run: {repository_id: 999, run_id: 123}})), /mismatched build acknowledgement/);
});

test('interrupted creation is never automatically repeated', async () => {
  let calls = 0;
  await assert.rejects(createBuild(values, env, async () => {
    calls++;
    throw new ActionError('Lost acknowledgement; build may already exist.');
  }), /may already exist/);
  assert.equal(calls, 1);
});
