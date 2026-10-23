# Quadraticc build action

Create an immutable build in [Quadraticc](https://app.quadrati.cc) after a successful
build. Supply an explicit version or let the server allocate the next patch in a
series such as `0.0.`. The action returns build information as step outputs.
Build links open the service’s `/workspaces/...` pages directly.

The action creates builds, marks existing builds as releases, or uploads test reports.
Deployment is a separate operation. This action does not upload or build artifacts.

## Quick start

In Quadraticc, open your project's **Settings**, create a project CI credential,
and copy it into a GitHub Actions secret named `QUADRATICC_TOKEN`. Copy the
workspace and project UUIDs from **Project identifiers** into the repository
variables `WORKSPACE_ID` and `PROJECT_ID`.

Add this step after your successful build:

```yaml
- name: Register build
  id: build
  uses: quadraticc/build-action@v1
  with:
    token: ${{ secrets.QUADRATICC_TOKEN }}
    workspace-id: ${{ vars.WORKSPACE_ID }}
    project-id: ${{ vars.PROJECT_ID }}
    version-prefix: '0.0.'

- name: Use the build version
  env:
    BUILD_VERSION: ${{ steps.build.outputs.version }}
    BUILD_URL: ${{ steps.build.outputs.url }}
  run: node -e "console.log(process.env.BUILD_VERSION, process.env.BUILD_URL)"
```

For an explicit version, replace `version-prefix` with `version: '1.2.3'`.
Supply exactly one of these inputs. Automatic numbering happens atomically in
Quadraticc; the action never reads builds to calculate a version itself.

Use `quadraticc/build-action@v1`, or pin a reviewed full commit SHA for an
immutable reference.

The action runs on the GitHub runner's Node 24 runtime and has no shell, Docker,
Python or checkout requirement. Keep self-hosted runners current enough to support
Node 24 actions. It does not need `GITHUB_TOKEN` permissions to contact Quadraticc;
set the surrounding workflow's permissions according to its build requirements.

## Inputs

| Name | Required | Meaning |
| --- | --- | --- |
| `url` | No | Quadraticc HTTPS origin. Defaults to `https://app.quadrati.cc`. A custom host and port are supported. No path, credentials, query or fragment. |
| `token` | Yes | Project-scoped `qcc_...` CI credential, passed from GitHub Secrets. This is not a GitHub token. |
| `workspace-id` | Yes | Workspace UUID. |
| `project-id` | Yes | Project UUID. |
| `version` | Build mode | Semantic version of at most 100 ASCII bytes, such as `0.0.1-abc123`. |
| `version-prefix` | Build mode | Canonical `major.minor.` series, such as `0.0.` or `1.2.`. |
| `commit-sha` | No | Full 40- or 64-character artifact commit SHA. Defaults to `${{ github.sha }}`. Override when the build uses a different commit. |
| `branch` | No | Branch/tag name; defaults to the PR head or runner ref name. |
| `version-suffix` | No | Optional SemVer suffix for `version-prefix`, such as `-${{ github.sha }}`. |
| `images` | No | JSON object containing up to 16 named SHA-256 digest references, such as `web` and `migrations`. |
| `metadata` | No | JSON object containing up to 64 non-secret string values, such as `migration_name`. |
| `is-release` | No | `true` to mark the new or existing build as a release. Defaults to `false`. Release status is one-way. Requires server migration `0032_build_releases.sql`. |
| `build-id` | No | Existing build UUID to promote instead of registering a build. Requires `is-release: 'true'`; omit version inputs, images, metadata and workflow linking. Context commit/branch defaults are ignored. |
| `link-workflow-run` | No | `true` to associate the current GitHub.com repository/run with the build or test report. Defaults to `false`. |
| `test-results-file` | No | Path to one nonempty UTF-8 XML report, at most 8 MiB. Selects upload mode; omit version inputs, images, metadata, build-id and is-release. No glob expansion. |
| `test-results-format` | No | `junit` (default) or `trx`. |
| `test-results-upload-id` | No | Retry key, 1–200 UTF-8 bytes. Defaults to `<run ID>/<run attempt>/<report basename>`; required outside a GitHub run. |
| `workflow-run-id` | No | Quadraticc workflow run UUID for test uploads, as an alternative to `link-workflow-run`. |

The encoded build JSON request is limited to 32 KiB. Versions follow SemVer 2.0.0 (no `v` prefix or leading zeros in numeric identifiers). Inputs go through
JSON serialization rather than shell interpolation.

To record a pushed container image, add your build's digest, for example:

```yaml
images: |
  {"web": "ghcr.io/acme/web@${{ steps.build.outputs.digest }}"}
```

This example assumes your image build/push step is named `build` and exposes a
`digest` output. Replace the repository with the one you actually pushed.
Quadraticc records the reference; it does not verify or host the image.

To register multiple images and migration metadata (requires server migration
`0026_build_details_and_cancellation.sql`), add:

```yaml
images: |
  {
    "web": ${{ toJSON(format('{0}/web@{1}', vars.ECR_REGISTRY, steps.web.outputs.digest)) }},
    "migrations": ${{ toJSON(format('{0}/migrations@{1}', vars.ECR_REGISTRY, steps.migrations.outputs.digest)) }}
  }
metadata: |
  {"migration_name": ${{ toJSON(steps.migration_info.outputs.name) }}}
```

HTTP deployments use the named `web` image. Images and metadata are immutable and
participate in numbered-build replay identity. Their combined encoded size is
limited to 12000 bytes; metadata values may be at most 4096 UTF-8 bytes each.
Metadata is readable by build viewers. Store credentials in environment secrets.
Each image must be a complete registry/repository reference pinned with
`@sha256:<64 lowercase hexadecimal characters>`.

## Test result uploads

Use a separate action step for each JUnit or Visual Studio TRX report. Uploads
need no build registration or version. For example, run after tests even when
they fail, provided a report was produced:

```yaml
- name: Upload test results
  if: ${{ !cancelled() && hashFiles('test-results/results.xml') != '' }}
  id: tests
  uses: quadraticc/build-action@v1
  with:
    token: ${{ secrets.QUADRATICC_TOKEN }}
    workspace-id: ${{ vars.WORKSPACE_ID }}
    project-id: ${{ vars.PROJECT_ID }}
    test-results-file: test-results/results.xml
    test-results-format: junit
    link-workflow-run: 'true'
```

Set `test-results-format: trx` for TRX. A checkout is unnecessary for build
registration; uploads require the report file to be present on the runner.
`branch` and `commit-sha` use the same context defaults as builds and can be
overridden. A branch is required for reports. Workflow association is optional;
`link-workflow-run` needs a connected GitHub.com repository. Alternatively,
supply the project's Quadraticc `workflow-run-id` UUID, without workflow linking.
Quadraticc resolves linked workflows and their initiating users; the action does
not send or guess a user from GitHub's actor name. There is no caller-supplied
user field in the [CI API contract](https://www.quadrati.cc/docs/ci-api/).

New uploads return HTTP 201; exact replay with the same upload ID returns 200
and the same receipt. A changed report or metadata with that ID returns 409.
The default upload ID includes run ID, attempt and basename. Set an explicit
`test-results-upload-id` for separate files with the same basename, multiple
executions in one attempt, or uploads outside GitHub. Keep it within 200 UTF-8
bytes (including the default); do not include secrets. For example:
`${{ github.run_id }}/${{ github.run_attempt }}/linux-unit`.
Use a new ID for each new execution/attempt; after a lost acknowledgement,
retry with the original ID and identical report and metadata. Uploads never
retry automatically.

The server parses the XML; the action preserves its UTF-8 contents, including a
leading BOM, and JSON-escapes it. The 8 MiB decoded report limit is independent
of the 32 KiB build request limit. Server parsing limits are 10,000 cases, 64 XML
levels, 200,000 elements and a conservative 32 MiB normalized-case JSON budget.
DTDs, unsupported XML/outcomes and invalid durations are rejected. Empty suites
are supported. Counts reflect actual test cases. Reports, names and captured
output are visible to project build viewers: keep secrets out of report files.
Reports appear on the project's **Tests** page, indexed by branch and commit;
workflow discovery can resolve a link after upload.

Upload success means the report was accepted, even if it contains failed tests.
The action leaves test failure policy to the test step. Only `test-report-id`
and `test-results` are emitted in upload mode; the latter is a JSON receipt such
as `{"id":"report UUID","total":4,"passed":1,"failed":1,"errors":1,"skipped":1}`.
No outputs are emitted on invalid receipts or upload failures. These receipts
contain counts only; XML and provider response bodies are never logged.

## Outputs

| Name | Value |
| --- | --- |
| `test-report-id` | Accepted report UUID, upload mode only. |
| `test-results` | JSON receipt with id and test counts, upload mode only. |
| `is-release` | `true` if the acknowledged build is a release, otherwise `false`. |
| `build-id` | Build UUID. |
| `version` | Explicit or server-assigned version. |
| `commit-sha` | Recorded commit SHA. |
| `branch` | Recorded branch/tag name, or empty. |
| `images` | Named image references as JSON; `{}` when absent. |
| `metadata` | Build metadata as JSON; `{}` when absent. |
| `url` | Link to the build in Quadraticc's project build history. |
| `created` | String `true` for creation; `false` when numbered creation reuses an identical build. |

In build mode, no outputs are emitted until the server acknowledgement matches
the submitted metadata and expected version. For a conditional next step, use
`if: steps.build.outputs.created == 'true'`.

## Optional workflow association

Ordinary build creation needs no GitHub App installation or repository connection.
To link a build to a run monitored by Quadraticc:

1. A repository administrator connects the repository to this Quadraticc project
   through its GitHub App integration.
2. Use `link-workflow-run: 'true'` on the build action step.

The action adds the numeric GitHub repository/run IDs from the runner context.
Quadraticc can associate a fast build even before it records the dispatch
response. This option requires a server with workflow-source support and currently
supports GitHub.com only. It is CI-supplied provenance, not artifact attestation.

## Versions, replay and failures

Explicit versions use `POST .../builds`. Success returns `201`; an existing
version returns `409` and fails the action. A conflict is never silently accepted.

Automatic versions use `POST .../builds/next`. The server allocates one greater
than the highest canonical version in the chosen series, starting at patch 1.
Exact replay of commit, branch, suffix, named images, metadata and optional workflow source in that project/series returns the existing CI build with `200` and `created=false`. The patch counter includes prereleases and build metadata in that series.

To allocate a new build for every CI attempt, include its identity explicitly:

```yaml
version-suffix: '-${{ github.sha }}'
metadata: |
  {"ci_run": "${{ github.run_id }}", "ci_attempt": "${{ github.run_attempt }}"}
```

Repeating the exact payload can recover a lost acknowledgement. The action no longer generates build notes. `image-reference` and `build-notes` inputs/outputs have been removed; use `images`.

Each action step makes one request, verifies TLS, refuses redirects and bounds request
time and response size. It never automatically repeats an ambiguous creation.
A timeout or server failure can happen after creation: inspect project history
before retrying an explicit version. For automatic numbering, exact payload replay
uses the API's existing idempotency behavior.

| Error | Check |
| --- | --- |
| `400` | Inputs; for workflow association, the same-project repository connection and server support. |
| `401` | Project CI credential and revocation. |
| `403` | Workspace/project scope and workspace lifecycle/read-only state. |
| `404` | URL and server support for the selected endpoint. |
| `409` | Existing explicit version or workspace resource quota. |
| `429` | API budget; wait before another request. |
| Redirect | Use the final HTTPS origin. Authorization is never forwarded to a redirect. |
| TLS/timeout/mismatched response | HTTPS trust, connectivity, reverse proxy, server logs and build history. |

Credentials are masked through the Actions toolkit. Errors identify HTTP status
and safe guidance without printing provider bodies or credentials. The credential
is sent only to the configured HTTPS origin. Standard Node trust settings such as
`NODE_EXTRA_CA_CERTS` can add a private CA on a self-hosted runner; certificate
verification stays enabled. There is no insecure-TLS or redirect-following option.

## Development

Use Node.js 24 or newer:

```sh
npm ci
npm run check
npm run build
npm test
npm audit --audit-level=moderate
```

Commit the entire `dist/` directory, including its generated `package.json` and
third-party `licenses.txt`. Customers execute this bundle directly and do not run
`npm install`. Dependencies are locked. TypeScript compilation runs before ncc so
the bundler does not depend on a particular TypeScript compiler API.

Tests cover both version modes, exact acknowledgements, workflow context, input
limits, credential/output handling, real local HTTPS, certificate rejection,
redirect refusal, response bounds, interruption, timeout and the standalone bundle.
Test certificates are generated in memory; no private keys or live customer
credentials are included. Tests contact no production Quadraticc instance.

CI checks non-draft pull requests, main pushes, version tags and manual runs on
Ubuntu, macOS and Windows with Node 24. It rebuilds the bundle and rejects stale
or untracked distribution files. The remote OS matrix needs a first GitHub run;
local testing alone does not establish those runner results.

## License

MIT. Bundled dependency notices are in `dist/licenses.txt`.

## Server compatibility

This v1 action targets the epoch-13 Builds API (`/builds`, named `images`, `branch`, optional `version_suffix`). Upgrade the server before using this revision. Historical server builds retain their versions; old image references migrate into `images.web`.

## Releases

Set `is-release: 'true'` when registering a release build. To promote an existing
build later, use its ID without version inputs:

```yaml
- name: Mark approved build as a release
  uses: quadraticc/build-action@v1
  with:
    token: ${{ secrets.QUADRATICC_TOKEN }}
    workspace-id: ${{ vars.WORKSPACE_ID }}
    project-id: ${{ vars.PROJECT_ID }}
    build-id: ${{ needs.build.outputs.build-id }}
    is-release: 'true'
```

Promotion is idempotent, returns the original artifact's outputs with
`created: 'false'`, and never changes its version, images or metadata. A numbered
registration replay also retains the build ID when release status changes:
`is-release: 'true'` promotes a matching build; `false` never removes release status.
Project CI credentials can promote builds only in their own project. Environments
configured for releases only reject ordinary builds. Upgrade the server before
publishing or using this action's release inputs.
