import {request, type RequestOptions} from 'node:https';
import type {ClientRequest, IncomingMessage} from 'node:http';

export class ActionError extends Error {}

export interface Reply {
  status: number;
  contentType: string;
  body: string;
}

export type RequestFactory = (url: URL, options: RequestOptions,
  callback: (response: IncomingMessage) => void) => ClientRequest;

const ambiguity = 'The release may already exist. No automatic retry was made; inspect release history before retrying an explicit version.';
const maximumResponseBytes = 64 * 1024;
const transportCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET',
  'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'HPE_HEADER_OVERFLOW']);

// Node's HTTPS client does not follow redirects. Never forward the CI credential
// to a Location header or print transport/provider errors containing user data.
export function postJSON(url: URL, token: string, body: string,
  factory: RequestFactory = request, timeoutMs = 30_000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    const finish = (error?: ActionError, reply?: Reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        incoming?.destroy();
        outgoing?.destroy();
      } else {
        resolve(reply!);
      }
    };
    const timer = setTimeout(() => finish(new ActionError(`Quadraticc request timed out. ${ambiguity}`)), timeoutMs);
    timer.unref();
    try {
      outgoing = factory(url, {
        method: 'POST', agent: false, minVersion: 'TLSv1.2', rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json', 'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'quadraticc/release-action/1',
        },
      }, response => {
        incoming = response;
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('error', () => finish(new ActionError(`Quadraticc response was interrupted. ${ambiguity}`)));
        response.on('aborted', () => finish(new ActionError(`Quadraticc response was interrupted. ${ambiguity}`)));
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maximumResponseBytes) {
            finish(new ActionError(`Quadraticc response exceeded its size limit. ${ambiguity}`));
          } else {
            chunks.push(chunk);
          }
        });
        response.on('end', () => {
          try {
            const contentType = response.headers['content-type'] ?? '';
            finish(undefined, {status: response.statusCode ?? 0, contentType,
              body: new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))});
          } catch {
            finish(new ActionError(`Quadraticc returned an invalid response. ${ambiguity}`));
          }
        });
      });
      outgoing.on('error', (error: NodeJS.ErrnoException) => {
        const code = error.code && transportCodes.has(error.code) ? error.code : 'NETWORK_ERROR';
        finish(new ActionError(`Could not complete the verified HTTPS request to Quadraticc (${code}). ${ambiguity}`));
      });
      outgoing.end(body);
    } catch {
      finish(new ActionError(`Could not send the Quadraticc request. ${ambiguity}`));
    }
  });
}
