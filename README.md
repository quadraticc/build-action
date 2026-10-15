# Quadraticc release action

Create an immutable release in [Quadraticc](https://quadrati.cc) after a successful
build. Supply an explicit version or let the server allocate the next patch in a
series such as `0.0.`. The action returns release information as step outputs.

Version 1 creates releases. Retrieval and deployment are separate operations and
are outside this version's scope. This action does not upload or build artifacts.

## Quick start

In Quadraticc, open your project's **Settings**, create a project CI credential,
and copy it into a GitHub Actions secret named `QUADRATICC_TOKEN`. Copy the
workspace and project UUIDs from **Project identifiers** into the repository
variables `WORKSPACE_ID` and `PROJECT_ID`.

Add this step after your successful build:

```yaml
- name: Register release
  id: release
  uses: quadraticc/release-action@v1
  with:
    token: ${{ secrets.QUADRATICC_TOKEN }}
    workspace-id: ${{ vars.WORKSPACE_ID }}
    project-id: ${{ vars.PROJECT_ID }}
    version-prefix: '0.0.'

- name: Use the release version
  env:
    RELEASE_VERSION: ${{ steps.release.outputs.version }}
    RELEASE_URL: ${{ steps.release.outputs.url }}
  run: node -e "console.log(process.env.RELEASE_VERSION, process.env.RELEASE_URL)"
```

For an explicit version, replace `version-prefix` with `version: '1.2.3'`.
Supply exactly one of these inputs. Automatic numbering happens atomically in
Quadraticc; the action never reads releases to calculate a version itself.

The `@v1` example becomes usable after the maintainer publishes that tag. Customers
can pin the action to a reviewed full commit SHA for an immutable reference.

The action runs on the GitHub runner's Node 24 runtime and has no shell, Docker,
Python or checkout requirement. Keep self-hosted runners current enough to support
Node 24 actions. It does not need `GITHUB_TOKEN` permissions to contact Quadraticc;
set the surrounding workflow's permissions according to its build requirements.

## Inputs

| Name | Required | Meaning |
| --- | --- | --- |
| `url` | No | Quadraticc HTTPS origin. Defaults to `https://quadrati.cc`. A custom host and port are supported. No path, credentials, query or fragment. |
| `token` | Yes | Project-scoped `qcc_...` CI credential, passed from GitHub Secrets. This is not a GitHub token. |
| `workspace-id` | Yes | Workspace UUID. |
| `project-id` | Yes | Project UUID. |
| `version` | One version input | Explicit nonempty version, at most 100 UTF-8 bytes. |
| `version-prefix` | One version input | Canonical `major.minor.` series, such as `0.0.` or `1.2.`. |
| `commit-sha` | No | Full 40- or 64-character artifact commit SHA. Defaults to `${{ github.sha }}`. Override when the build uses a different commit. |
| `image-reference` | No | Image reference, at most 2048 UTF-8 bytes. Use the pushed digest for deployable images. |
| `release-notes` | No | Notes, at most 16384 UTF-8 bytes. Empty input generates `GitHub Actions run <id>, attempt <attempt>.` when that context is available. |
| `link-workflow-run` | No | `true` to associate the current GitHub.com repository/run with the release. Defaults to `false`. |

The encoded JSON request is limited to 32 KiB. Versions reject surrounding
whitespace/control characters; notes support multiline text. Inputs go through
JSON serialization rather than shell interpolation.

To record a pushed container image, add your build's digest, for example:

```yaml
image-reference: ghcr.io/acme/web@${{ steps.build.outputs.digest }}
release-notes: Build the web server and worker.
```

This example assumes your image build/push step is named `build` and exposes a
`digest` output. Replace the repository with the one you actually pushed.
Quadraticc records the reference; it does not verify or host the image.

## Outputs

| Name | Value |
| --- | --- |
| `release-id` | Release UUID. |
| `version` | Explicit or server-assigned version. |
| `commit-sha` | Recorded commit SHA. |
| `image-reference` | Recorded image reference, or an empty string. |
| `release-notes` | Recorded notes. |
| `url` | Link to the release in Quadraticc's project release history. |
| `created` | String `true` for creation; `false` when numbered creation reuses an identical release. |

No outputs are emitted until the server acknowledgement matches the submitted
metadata and expected version. For a conditional next step, use
`if: steps.release.outputs.created == 'true'`.

## Optional workflow association

Ordinary release creation needs no GitHub App installation or repository connection.
To link a release to a run monitored by Quadraticc:

1. A repository administrator connects the repository to this Quadraticc project
   through its GitHub App integration.
2. Use `link-workflow-run: 'true'` on the release action step.

The action adds the numeric GitHub repository/run IDs from the runner context.
Quadraticc can associate a fast release even before it records the dispatch
response. This option requires a server with workflow-source support and currently
supports GitHub.com only. It is CI-supplied provenance, not artifact attestation.

## Versions, replay and failures

Explicit versions use `POST .../releases`. Success returns `201`; an existing
version returns `409` and fails the action. A conflict is never silently accepted.

Automatic versions use `POST .../releases/next`. The server allocates one greater
than the highest canonical version in the chosen series, starting at patch 1.
Exact metadata replay in that project/series returns the existing release with
`200` and `created=false`. Commit, image, notes and optional source IDs all
participate in replay identity.

Default notes include the run and attempt, so rerunning a GitHub job usually
requests a new release. If you need to replay an earlier numbered request after
a lost acknowledgement, supply its exact original notes and other metadata.
Stable custom notes can intentionally cause reuse across runs of the same build.

The action makes one request, verifies TLS, refuses redirects and bounds request
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
| TLS/timeout/mismatched response | HTTPS trust, connectivity, reverse proxy, server logs and release history. |

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
