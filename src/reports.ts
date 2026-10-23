import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {basename} from 'node:path';
import {artifactSource, connection, uuid, workflowSource, type Environment, type Values} from './build.js';
import {ActionError, postJSON} from './http.js';

export interface TestReceipt {
  id: string;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
}

const maximumReportBytes = 8 * 1024 * 1024;
const ambiguity = 'The report may already exist. No automatic retry was made; retry only with the same upload ID and identical report and metadata.';
const invalidReceipt = () => new ActionError(`Quadraticc returned an invalid test report receipt. ${ambiguity}`);
const boundedText = (value: string, limit: number) => Boolean(value) &&
  Buffer.byteLength(value) <= limit && !/\p{Cc}|[\uD800-\uDFFF]/u.test(value);

async function readReport(path: string): Promise<string> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maximumReportBytes) throw new Error();
      // Bound the read even if a producer is still writing to the file.
      const buffer = Buffer.alloc(maximumReportBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const {bytesRead} = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (!size || size > maximumReportBytes) throw new Error();
      // Preserve a leading BOM and reject invalid UTF-8 instead of replacing bytes.
      return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(buffer.subarray(0, size));
    } finally {
      await file.close();
    }
  } catch {
    throw new ActionError('Input test-results-file must name a readable, nonempty UTF-8 report file of at most 8 MiB.');
  }
}

export async function uploadTestResults(values: Values, env: Environment,
  send: typeof postJSON = postJSON): Promise<TestReceipt> {
  const {origin, workspace, project, token} = connection(values);
  if (['version', 'version-prefix', 'version-suffix', 'build-id', 'images', 'metadata'].some(key => values[key]) ||
      values['is-release'] && values['is-release'] !== 'false') {
    throw new ActionError('Test result uploads cannot be combined with build registration or release inputs. Use separate action steps.');
  }
  const source = artifactSource(values, env);
  if (!source.branch) throw new ActionError('Input branch is required for test result uploads.');
  const format = values['test-results-format'] || 'junit';
  if (!['junit', 'trx'].includes(format)) throw new ActionError('Input test-results-format must be junit or trx.');
  const filename = basename(values['test-results-file'] || '');
  if (!boundedText(filename, 255) || /[/\\]/.test(filename) || ['.', '..'].includes(filename)) {
    throw new ActionError('Input test-results-file must have a basename of at most 255 bytes.');
  }
  const workflow = workflowSource(values, env);
  const workflowID = values['workflow-run-id'] || '';
  if (workflowID && (!uuid.test(workflowID) || workflow)) {
    throw new ActionError('Input workflow-run-id must be a Quadraticc workflow run UUID and cannot be combined with link-workflow-run.');
  }
  let uploadID = values['test-results-upload-id'] || '';
  if (!uploadID) {
    if (![env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT].every(value => value && /^[1-9][0-9]*$/.test(value))) {
      throw new ActionError('Input test-results-upload-id is required without a GitHub run ID and attempt.');
    }
    uploadID = `${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT}/${filename}`;
  }
  if (!boundedText(uploadID, 200)) throw new ActionError('Input test-results-upload-id must be 1–200 UTF-8 bytes without control characters.');
  const report = await readReport(values['test-results-file'] || '');
  const payload = {upload_id: uploadID, filename, format, ...source, report,
    ...(workflow ? {workflow_run: workflow} : {}),
    ...(workflowID ? {workflow_run_id: workflowID.toLowerCase()} : {})};
  const endpoint = new URL(`/api/v1/workspaces/${workspace}/projects/${project}/test-results`, origin);
  const reply = await send(endpoint, token, JSON.stringify(payload));
  if (![200, 201].includes(reply.status)) {
    const guidance: Record<number, string> = {
      400: 'Check report XML, format, metadata, workflow association and API parsing limits.',
      401: 'Check the project CI credential; it may be invalid or revoked.',
      403: 'Check project scope and workspace lifecycle.',
      404: 'Check the URL and server support for test result ingestion.',
      409: 'The upload ID already exists with different content or metadata. Use distinct IDs for distinct reports or attempts.',
      413: 'The report exceeds the server size limit.',
      415: 'The server did not accept the JSON request.',
      429: 'The API rate limit was reached. Wait before retrying.',
    };
    const message = reply.status >= 300 && reply.status < 400 ? 'Redirects are refused; use the final HTTPS origin.' : guidance[reply.status] || ambiguity;
    throw new ActionError(`Quadraticc returned HTTP ${reply.status}. ${message}`);
  }
  if (reply.contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw invalidReceipt();
  let data: unknown;
  try {data = JSON.parse(reply.body);} catch {throw invalidReceipt();}
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidReceipt();
  const receipt = data as Record<string, unknown>;
  if (typeof receipt.id !== 'string' || !uuid.test(receipt.id) ||
      !['total', 'passed', 'failed', 'errors', 'skipped'].every(key =>
        Number.isInteger(receipt[key]) && Number(receipt[key]) >= 0 && Number(receipt[key]) <= 10_000) ||
      receipt.total !== Number(receipt.passed) + Number(receipt.failed) + Number(receipt.errors) + Number(receipt.skipped)) throw invalidReceipt();
  // Emit only validated receipt fields, never arbitrary provider response data.
  return {id: receipt.id, total: Number(receipt.total), passed: Number(receipt.passed),
    failed: Number(receipt.failed), errors: Number(receipt.errors), skipped: Number(receipt.skipped)};
}
