import {ActionError, postJSON, type Reply} from './http.js';

export type Values = Record<string, string | undefined>;
export type Environment = Record<string, string | undefined>;
export interface WorkflowSource { repository_id: number; run_id: number }
export interface Payload {
  version?: string;
  version_prefix?: string;
  commit_sha: string;
  image_reference?: string;
  build_notes?: string;
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
  id: string;
  version: string;
  commit: string;
  image: string;
  notes: string;
  url: string;
  created: boolean;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const controls = /\p{Cc}/u;
const wellFormed = (value: string) => !/[\uD800-\uDFFF]/u.test(value);
const validVersion = (value: string) => value.length > 0 && Buffer.byteLength(value) <= 100 &&
  wellFormed(value) && value.trim() === value && !controls.test(value);
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
  if (version && !validVersion(version)) inputError('version', 'must be nonempty, at most 100 UTF-8 bytes, and contain no surrounding whitespace or control characters');
  if (prefix && (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.$/.test(prefix) || prefix.length > 98)) {
    inputError('version-prefix', 'must be a canonical major.minor. prefix, such as 0.0.');
  }
  const commit = values['commit-sha'] || env.GITHUB_SHA || '';
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) inputError('commit-sha', 'must be a full 40- or 64-character hexadecimal commit SHA');
  const image = values['image-reference'] ?? '';
  if (!wellFormed(image) || Buffer.byteLength(image) > 2048 || /[\r\n\0]/.test(image)) inputError('image-reference', 'must be at most 2048 UTF-8 bytes and contain no line breaks or NUL');
  let notes = values['build-notes'] ?? '';
  if (!notes && env.GITHUB_RUN_ID && env.GITHUB_RUN_ATTEMPT) {
    if (!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID) || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT)) {
      throw new ActionError('GitHub run and attempt context is invalid.');
    }
    notes = `GitHub Actions run ${env.GITHUB_RUN_ID}, attempt ${env.GITHUB_RUN_ATTEMPT}.`;
  }
  if (!wellFormed(notes) || Buffer.byteLength(notes) > 16384 || notes.includes('\0')) inputError('build-notes', 'must be at most 16384 UTF-8 bytes and contain no NUL');
  const link = values['link-workflow-run'] || 'false';
  if (!['true', 'false'].includes(link)) inputError('link-workflow-run', 'must be true or false');
  const payload: Payload = {commit_sha: commit};
  if (version) payload.version = version; else payload.version_prefix = prefix;
  if (image) payload.image_reference = image;
  if (notes) payload.build_notes = notes;
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
      (data.image_reference ?? '') !== (payload.image_reference ?? '') ||
      (data.build_notes ?? '') !== (payload.build_notes ?? '') ||
      typeof data.created_at !== 'string' || !Number.isFinite(Date.parse(data.created_at))) throw mismatch();
  if (payload.version ? data.version !== payload.version :
    !data.version.startsWith(payload.version_prefix!) || !/^(0|[1-9][0-9]*)$/.test(data.version.slice(payload.version_prefix!.length))) throw mismatch();
  const source = data.workflow_run as Record<string, unknown> | null | undefined;
  if (payload.workflow_run ? !source || source.repository_id !== payload.workflow_run.repository_id || source.run_id !== payload.workflow_run.run_id : source != null) throw mismatch();
  return {id: data.id, version: data.version, commit: payload.commit_sha,
    image: payload.image_reference ?? '', notes: payload.build_notes ?? '', created: reply.status === 201,
    url: `${prepared.origin}/workspaces/${prepared.workspace}/projects/${prepared.project}?view=builds#build-${data.id}`};
}

export async function createBuild(values: Values, env: Environment,
  send: typeof postJSON = postJSON): Promise<Result> {
  const prepared = prepare(values, env);
  const reply = await send(prepared.endpoint, prepared.token, JSON.stringify(prepared.payload));
  return acknowledged(prepared, reply);
}
