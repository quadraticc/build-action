export const values = {
  url: 'https://quadrati.cc', token: `qcc_${'x'.repeat(43)}`,
  'workspace-id': '11111111-1111-1111-1111-111111111111',
  'project-id': '22222222-2222-2222-2222-222222222222',
  'version-prefix': '0.0.', images: JSON.stringify({web: `ghcr.io/example/app@sha256:${'b'.repeat(64)}`}),
};
export const env = {
  GITHUB_SHA: 'a'.repeat(40), GITHUB_REF_NAME: 'main', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_REPOSITORY_ID: '42', GITHUB_SERVER_URL: 'https://github.com',
};
export const buildID = '33333333-3333-3333-3333-333333333333';
export function acknowledgement(payload, status = 201, changes = {}) {
  const {version_prefix, version_suffix, ...metadata} = payload;
  return {status, contentType: 'application/json; charset=utf-8', body: JSON.stringify({
    ...metadata, version: payload.version || `${version_prefix}7${version_suffix ?? ''}`, id: buildID,
    created_at: '2026-10-15T00:00:00Z', ...changes,
  })};
}
