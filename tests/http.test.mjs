import {test, before} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {once} from 'node:events';
import {cp, mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {parse} from 'yaml';
import selfsigned from 'selfsigned';
import {postJSON} from '../build/http.js';
import {createBuild} from '../build/build.js';
import {values, env, acknowledgement} from './fixtures.mjs';

let pems;
before(async () => {
  // Fresh keys exist only in this test process. No private test keys are shipped.
  pems = await selfsigned.generate([{name: 'commonName', value: 'localhost'}], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
    notBeforeDate: new Date(Date.now() - 60_000),
    notAfterDate: new Date(Date.now() + 86_400_000),
    extensions: [{name: 'basicConstraints', cA: true},
      {name: 'subjectAltName', altNames: [{type: 2, value: 'localhost'}, {type: 7, ip: '127.0.0.1'}]}],
  });
});

async function server(t, handler) {
  const listener = https.createServer({key: pems.private, cert: pems.cert}, handler);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
  });
  return new URL(`https://127.0.0.1:${listener.address().port}`);
}
const trusted = (url, options, callback) => {
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.minVersion, 'TLSv1.2');
  return https.request(url, {...options, ca: pems.cert}, callback);
};
async function requestBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

test('real HTTPS sends JSON and the project token once with a bounded, verified connection', async t => {
  let requests = 0;
  const origin = await server(t, async (request, response) => {
    requests++;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, `Bearer ${values.token}`);
    assert.equal(request.headers['content-type'], 'application/json');
    const payload = await requestBody(request);
    const result = acknowledgement(payload);
    response.writeHead(result.status, {'content-type': result.contentType});
    response.end(result.body);
  });
  const result = await createBuild({...values, url: origin.origin}, env,
    (url, token, body) => postJSON(url, token, body, trusted));
  assert.equal(result.version, '0.0.7');
  assert.equal(requests, 1);
});

test('redirects never forward the bearer token or cause a second request', async t => {
  let forwarded = 0;
  const other = await server(t, (_request, response) => {forwarded++; response.end();});
  const origin = await server(t, (_request, response) => {
    response.writeHead(302, {location: `${other.origin}/stolen`});
    response.end('private redirected provider output');
  });
  await assert.rejects(createBuild({...values, url: origin.origin}, env,
    (url, token, body) => postJSON(url, token, body, trusted)), /HTTP 302.*Redirects are refused/);
  assert.equal(forwarded, 0);
});

test('certificate validation remains enabled', async t => {
  const origin = await server(t, (_request, response) => response.end('{}'));
  await assert.rejects(postJSON(origin, values.token, '{}'), /verified HTTPS request/);
});

test('request deadlines, oversized responses and interrupted responses fail without retry or provider disclosure', async t => {
  await t.test('deadline', async t => {
    let requests = 0;
    const origin = await server(t, () => {requests++;});
    await assert.rejects(postJSON(origin, values.token, '{}', trusted, 500), /timed out/);
    assert.equal(requests, 1);
  });
  await t.test('response bound', async t => {
    const origin = await server(t, (_request, response) => response.end('private'.repeat(10_000)));
    await assert.rejects(postJSON(origin, values.token, '{}', trusted), error => {
      assert.match(error.message, /size limit/);
      assert.ok(!error.message.includes('private'));
      return true;
    });
  });
  await t.test('interrupted response', async t => {
    const origin = await server(t, (_request, response) => {
      response.writeHead(201, {'content-type': 'application/json', 'content-length': 10000});
      response.write('{"private":');
      setImmediate(() => response.destroy());
    });
    await assert.rejects(postJSON(origin, values.token, '{}', trusted), /interrupted/);
  });
  await t.test('invalid UTF-8', async t => {
    const origin = await server(t, (_request, response) => response.end(Buffer.from([0xc3, 0x28])));
    await assert.rejects(postJSON(origin, values.token, '{}', trusted), /invalid response/);
  });
});

test('the committed action bundle runs standalone and writes safe, multiline GitHub outputs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'quadraticc-action-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const ca = join(directory, 'public-ca.pem'), output = join(directory, 'outputs');
  await writeFile(ca, pems.cert);
  await writeFile(output, '');
  await cp(new URL('../dist/', import.meta.url), join(directory, 'dist'), {recursive: true});
  let requests = 0;
  const origin = await server(t, async (request, response) => {
    requests++;
    const payload = await requestBody(request);
    assert.equal(payload.build_notes, 'Build finished\n::warning::plain notes');
    const result = acknowledgement(payload);
    response.writeHead(result.status, {'content-type': result.contentType});
    response.end(result.body);
  });
  const context = {...process.env, ...env, NODE_OPTIONS: '', NODE_EXTRA_CA_CERTS: ca, GITHUB_OUTPUT: output};
  delete context.NODE_TLS_REJECT_UNAUTHORIZED;
  for (const key of Object.keys(context)) if (key.startsWith('INPUT_')) delete context[key];
  for (const [key, value] of Object.entries({...values, url: origin.origin,
    'build-notes': 'Build finished\n::warning::plain notes'})) context[`INPUT_${key.toUpperCase()}`] = value;
  // The runtime has no source tree, build files or node_modules to fall back to.
  const metadata = parse(await readFile(new URL('../action.yml', import.meta.url), 'utf8'));
  const child = spawn(process.execPath, [metadata.runs.main], {cwd: directory, env: context});
  let stdout = '', stderr = '';
  child.stdout.on('data', data => {stdout += data;});
  child.stderr.on('data', data => {stderr += data;});
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr + stdout);
  assert.equal(requests, 1);
  const recorded = await readFile(output, 'utf8');
  assert.match(recorded, /version<<[^\r\n]+\r?\n0\.0\.7/);
  assert.match(recorded, /created<<[^\r\n]+\r?\ntrue/);
  assert.match(recorded, /Build finished\n::warning::plain notes/);
  assert.ok(!recorded.includes(values.token));
  const visible = stdout.split(/\r?\n/).filter(line => !line.startsWith('::add-mask::')).join('\n');
  assert.ok(!visible.includes(values.token));
  assert.ok(!visible.includes('::warning::plain notes'));
});
