/**
 * Loopback HTTPS server hosting the OpenAI-compatible runner proxy (Phase 4).
 *
 * Binds to 127.0.0.1 only — the endpoint exists for the region's BYOK adapter to
 * reach the local model server, and must never be exposed on a public interface.
 * The caller supplies the certificate from `./tls.ts`.
 */

import { createServer, type Server } from 'node:https';
import { createRunnerHandler, type RunnerHandlerOptions } from './handler.js';

export type LocalRunnerServerOptions = Omit<RunnerHandlerOptions, 'fetchFn'> & {
  keyPem: string;
  certPem: string;
  /** Loopback port. 0 lets the OS pick; the bound port is reported once listening. */
  port?: number;
  fetchFn?: typeof fetch;
};

export type LocalRunnerServer = {
  /** The `https://127.0.0.1:<port>/v1` base to register as the BYOK endpoint. */
  readonly endpointUrl: string;
  readonly port: number;
  /** Stops accepting connections. Idempotent. */
  close(): Promise<void>;
};

/** Start the runner; resolves once the socket is listening so `port` is real. */
export async function startLocalRunnerServer(options: LocalRunnerServerOptions): Promise<LocalRunnerServer> {
  const handle = createRunnerHandler({
    upstreamBaseUrl: options.upstreamBaseUrl,
    apiKey: options.apiKey,
    fetchFn: options.fetchFn,
  });

  const server = createServer({ key: options.keyPem, cert: options.certPem }, (req, res) => {
    void readBody(req).then(async (body) => {
      const out = await handle({
        method: req.method ?? 'GET',
        path: (req.url ?? '/').split('?')[0],
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      });
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    });
  });

  const port = await listen(server, options.port ?? 0);
  return {
    port,
    endpointUrl: `https://127.0.0.1:${port}/v1`,
    close: () => close(server),
  };
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Bind loopback explicitly; never 0.0.0.0.
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) resolve(addr.port);
      else reject(new Error('runner server has no address'));
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
