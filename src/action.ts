import * as core from '@actions/core';
import {ActionError, postJSON} from './http.js';
import {createRelease, type Environment, type Values} from './release.js';

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
    for (const key of ['url', 'workspace-id', 'project-id', 'version', 'version-prefix',
      'commit-sha', 'image-reference', 'release-notes', 'link-workflow-run']) {
      values[key] = toolkit.getInput(key, {trimWhitespace: false});
    }
    const release = await createRelease(values, environment, send);
    const outputs = {'release-id': release.id, version: release.version,
      'commit-sha': release.commit, 'image-reference': release.image,
      'release-notes': release.notes, url: release.url, created: String(release.created)};
    for (const [key, value] of Object.entries(outputs)) toolkit.setOutput(key, value);
    toolkit.info(release.created ? 'Quadraticc release created.' : 'Identical Quadraticc release reused.');
  } catch (error) {
    toolkit.setFailed(error instanceof ActionError ? error.message : 'The release action could not complete. No provider response or credentials were logged; inspect release history before retrying an explicit version.');
  }
}
