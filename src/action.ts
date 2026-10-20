import * as core from '@actions/core';
import {ActionError, postJSON} from './http.js';
import {createBuild, type Environment, type Values} from './build.js';

export interface Toolkit {
  getInput(name: string, options: {trimWhitespace: boolean}): string;
  setSecret(value: string): void;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  info(message: string): void;
}

export async function run(toolkit: Toolkit = core, environment: Environment = process.env,
  send: typeof postJSON = postJSON): Promise<void> {
  try {
    // Mask before validating or doing network work, including an invalid token.
    const token = toolkit.getInput('token', {trimWhitespace: false});
    if (token) toolkit.setSecret(token);
    const values: Values = {token};
    for (const key of ['url', 'workspace-id', 'project-id', 'version', 'version-prefix', 'version-suffix', 'branch',
      'commit-sha', 'images', 'metadata', 'link-workflow-run', 'is-release', 'build-id']) {
      values[key] = toolkit.getInput(key, {trimWhitespace: false});
    }
    const build = await createBuild(values, environment, send);
    const outputs = {'is-release': String(build.isRelease), 'build-id': build.id, version: build.version,
      'commit-sha': build.commit, branch: build.branch, images: JSON.stringify(build.images), metadata: JSON.stringify(build.metadata), url: build.url, created: String(build.created)};
    for (const [key, value] of Object.entries(outputs)) toolkit.setOutput(key, value);
    toolkit.info(values['build-id'] ? 'Quadraticc build marked as a release.' : build.created ? 'Quadraticc build created.' : 'Identical Quadraticc build reused.');
  } catch (error) {
    toolkit.setFailed(error instanceof ActionError ? error.message : 'The build action could not complete. No provider response or credentials were logged; inspect build history before retrying an explicit version.');
  }
}
