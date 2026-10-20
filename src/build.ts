import {ActionError, postJSON, type Reply} from './http.js';

export type Values = Record<string, string | undefined>;
export type Environment = Record<string, string | undefined>;
export interface WorkflowSource { repository_id: number; run_id: number }
export interface Payload {
  images?: Record<string, string>;
  metadata?: Record<string, string>;
  version?: string;
  version_prefix?: string;
  commit_sha: string;
  branch?: string;
  version_suffix?: string;
  workflow_run?: WorkflowSource;
}
export interface Prepared {
  origin: string;
  workspace: string;
  project: string;
  token: string;
  payload: Payload;
  endpoint: URL;
}
export interface Result {
  images: Record<string, string>;
  metadata: Record<string, string>;
  id: string;
  version: string;
  commit: string;
  branch: string;
  url: string;
  created: boolean;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const controls = /\p{Cc}/u;
const wellFormed = (value: string) => !/[\uD800-\uDFFF]/u.test(value);
const validVersion = (value: string) => Buffer.byteLength(value) <= 100 &&
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(value) &&
  (value.split('+')[0]!.split('-').slice(1).join('-').split('.').every(part => !/^0[0-9]+$/.test(part)));
const inputError = (field: string, requirement: string): never => {throw new ActionError(`Input ${field} ${requirement}.`);};

function identifier(value: string, field: string): string {
  if (!uuid.test(value)) inputError(field, 'must be a workspace or project UUID');
  return value.toLowerCase();
}
function positiveID(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ActionError('Workflow linking requires valid numeric GitHub repository and run IDs.');
  }
  return Number(value);
}

const metadataKey = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const imageKey = /^[a-z][a-z0-9_-]{0,63}$/;
const pinnedImage = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/[a-z0-9]+(?:(?:[._/]|__|-+)[a-z0-9]+)*@sha256:[a-f0-9]{64}$/;
function mapInput(raw: string | undefined, field: 'images' | 'metadata'): Record<string, string> | undefined {
  if (!raw) return undefined;
  if (Buffer.byteLength(raw) > 32768) inputError(field, 'must be a bounded JSON object');
  let object: unknown;
  try {object = JSON.parse(raw);} catch {return inputError(field, 'must be a JSON object of string values');}
  if (!object || typeof object !== 'object' || Array.isArray(object)) inputError(field, 'must be a JSON object of string values');
  const entries = Object.entries(object as Record<string, unknown>);
  if (entries.length > (field === 'images' ? 16 : 64)) inputError(field, 'has too many entries');
  for (const [key, value] of entries) {
    if (!(field === 'images' ? imageKey : metadataKey).test(key) || typeof value !== 'string' ||
        !wellFormed(value) || value.includes('\0') || Buffer.byteLength(value) > (field === 'images' ? 2048 : 4096) ||
        field === 'images' && !pinnedImage.test(value)) inputError(field, 'contains an invalid name or value; images require complete SHA-256 digest references');
  }
  return object as Record<string, string>;
}
function sameMap(actual: unknown, expected: Record<string, string> | undefined): boolean {
  const wanted = expected ?? {};
  if (actual == null) return Object.keys(wanted).length === 0;
  return typeof actual === 'object' && !Array.isArray(actual) &&
    Object.keys(actual).length === Object.keys(wanted).length &&
    Object.entries(wanted).every(([key, value]) => Object.hasOwn(actual, key) && (actual as Record<string, unknown>)[key] === value);
}

export function prepare(values: Values, env: Environment): Prepared {
  const rawURL = values.url ?? '';
  let parsed: URL;
  try { parsed = new URL(rawURL); } catch { return inputError('url', 'must be an HTTPS origin'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password ||
      parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname) ||
      rawURL.trim() !== rawURL || controls.test(rawURL) || /[?#\\]/.test(rawURL)) {
    inputError('url', 'must be an HTTPS origin without credentials, path, query or fragment');
  }
  const origin = parsed.origin;
  const token = values.token ?? '';
  if (!/^qcc_[A-Za-z0-9_-]{43}$/.test(token)) inputError('token', 'must be a project CI credential');
  const workspace = identifier(values['workspace-id'] ?? '', 'workspace-id');
  const project = identifier(values['project-id'] ?? '', 'project-id');
  const version = values.version ?? '';
  const prefix = values['version-prefix'] ?? '';
  if (Boolean(version) === Boolean(prefix)) {
    throw new ActionError('Supply exactly one of version or version-prefix.');
  }
  if (version && !validVersion(version)) inputError('version', 'must be a semantic version of at most 100 bytes, such as 0.0.1-abc123');
  if (prefix && (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.$/.test(prefix) || prefix.length > 98)) {
    inputError('version-prefix', 'must be a canonical major.minor. prefix, such as 0.0.');
  }
  const commit = values['commit-sha'] || env.GITHUB_SHA || '';
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) inputError('commit-sha', 'must be a full 40- or 64-character hexadecimal commit SHA');
  const images = mapInput(values.images, 'images');
  const metadata = mapInput(values.metadata, 'metadata');
  if (values['image-reference'] || values['build-notes']) throw new ActionError('The image-reference and build-notes inputs were removed; use named images.');
  if (Buffer.byteLength(JSON.stringify([images ?? {}, metadata ?? {}])) > 12000) throw new ActionError('Encoded images and metadata must fit within 12000 bytes.');
  const branch = values.branch || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || '';
  if (!wellFormed(branch) || Buffer.byteLength(branch) > 255 || branch.trim() !== branch || controls.test(branch)) inputError('branch', 'must fit within 255 bytes without surrounding whitespace or control characters');
  const suffix = values['version-suffix'] || '';
  if (suffix && (!prefix || !/^[-+]/.test(suffix) || !validVersion(prefix + '1' + suffix))) inputError('version-suffix', 'must form a valid semantic version with version-prefix');
  const link = values['link-workflow-run'] || 'false';
  if (!['true', 'false'].includes(link)) inputError('link-workflow-run', 'must be true or false');
  const payload: Payload = {commit_sha: commit};
  if (version) payload.version = version; else payload.version_prefix = prefix;
  if (branch) payload.branch = branch;
  if (suffix) payload.version_suffix = suffix;
  if (images) payload.images = images;
  if (metadata) payload.metadata = metadata;
  if (link === 'true') {
    if (env.GITHUB_SERVER_URL !== 'https://github.com') throw new ActionError('Workflow linking currently supports GitHub.com runs only.');
    payload.workflow_run = {repository_id: positiveID(env.GITHUB_REPOSITORY_ID), run_id: positiveID(env.GITHUB_RUN_ID)};
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > 32768) throw new ActionError('The encoded build request exceeds the 32 KiB API limit.');
  const endpoint = new URL(`/api/v1/workspaces/${workspace}/projects/${project}/builds${prefix ? '/next' : ''}`, origin);
  return {origin, workspace, project, token, payload, endpoint};
}

const guidance: Record<number, string> = {
  400: 'Check build inputs and, when linking a workflow, that its repository is connected to this project.',
  401: 'Check the project CI credential; it may be invalid or revoked.',
  403: 'Check the workspace/project IDs, credential scope and workspace lifecycle.',
  404: 'Check the Quadraticc URL and that the server supports this build endpoint.',
  409: 'The explicit version already exists or a resource quota was reached. A conflict is not treated as success.',
  415: 'The server did not accept the JSON request; check the endpoint and reverse proxy.',
  429: 'The API rate limit was reached. Wait for the budget to reset before making another request.',
};
const mismatch = () => new ActionError('Quadraticc returned an invalid or mismatched build acknowledgement. The build may already exist; inspect build history before retrying an explicit version.');

function acknowledged(prepared: Prepared, reply: Reply): Result {
  const {payload} = prepared;
  const accepted = reply.status === 201 || Boolean(payload.version_prefix) && reply.status === 200;
  if (!accepted) {
    const message = reply.status >= 300 && reply.status < 400 ? 'Redirects are refused; use the final HTTPS origin.' :
      guidance[reply.status] ?? 'The build may already exist. Inspect build history before retrying an explicit version.';
    throw new ActionError(`Quadraticc returned HTTP ${reply.status}. ${message}`);
  }
  if (reply.contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw mismatch();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(reply.body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw mismatch();
  } catch { throw mismatch(); }
  if (typeof data.id !== 'string' || !uuid.test(data.id) || typeof data.version !== 'string' ||
      !validVersion(data.version) || data.commit_sha !== payload.commit_sha ||
      (data.branch ?? '') !== (payload.branch ?? '') || 'image_reference' in data || 'build_notes' in data ||
      !sameMap(data.images, payload.images) || !sameMap(data.metadata, payload.metadata) ||
      typeof data.created_at !== 'string' || !Number.isFinite(Date.parse(data.created_at))) throw mismatch();
  if (payload.version) {
    if (data.version !== payload.version) throw mismatch();
  } else {
    const suffix = payload.version_suffix ?? '';
    if (!data.version.startsWith(payload.version_prefix!) || suffix && !data.version.endsWith(suffix)) throw mismatch();
    const patch = data.version.slice(payload.version_prefix!.length, suffix ? -suffix.length : undefined);
    if (!/^(0|[1-9][0-9]*)$/.test(patch)) throw mismatch();
  }
  const source = data.workflow_run as Record<string, unknown> | null | undefined;
  if (payload.workflow_run ? !source || source.repository_id !== payload.workflow_run.repository_id || source.run_id !== payload.workflow_run.run_id : source != null) throw mismatch();
  return {id: data.id, version: data.version, commit: payload.commit_sha, images: payload.images ?? {}, metadata: payload.metadata ?? {},
    branch: payload.branch ?? '', created: reply.status === 201,
    url: `${prepared.origin}/workspaces/${prepared.workspace}/projects/${prepared.project}/builds?build=${data.id}`};
}

export async function createBuild(values: Values, env: Environment,
  send: typeof postJSON = postJSON): Promise<Result> {
  const prepared = prepare(values, env);
  const reply = await send(prepared.endpoint, prepared.token, JSON.stringify(prepared.payload));
  return acknowledged(prepared, reply);
}
