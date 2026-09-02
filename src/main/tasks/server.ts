import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import type { TaskStore, TaskUpsert } from './store.js';

export const DEFAULT_PORT = 7377;
/** Ports tried in order when the default is taken. */
const PORT_ATTEMPTS = 5;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 256 * 1024;

const DEFAULT_ENDPOINT_FILE = join(homedir(), '.config', 'llmusage', 'endpoint.json');

export type ProgressServer = {
  port: number;
  url: string;
  close(): Promise<void>;
};

type StartOptions = {
  store: TaskStore;
  port?: number;
  version: string;
  /** Discovery file to publish the resolved port to; null skips it (tests). */
  endpointFile?: string | null;
};

/**
 * Loopback-only JSON endpoint agents push progress to.
 *
 *   GET    /health
 *   GET    /v1/tasks                 -> derived tree
 *   GET    /v1/tasks/:id             -> one task (derived)
 *   POST   /v1/tasks                 -> upsert, id in body
 *   POST   /v1/tasks/:id             -> upsert, id from path
 *   DELETE /v1/tasks/:id             -> remove task + descendants
 *   DELETE /v1/tasks?finished=1      -> remove all done/failed
 *
 * Writes require a JSON content type, which makes them non-simple requests;
 * with no CORS headers served, a browser page cannot reach them.
 */
export async function startProgressServer(opts: StartOptions): Promise<ProgressServer> {
  const server = createServer((req, res) => {
    handle(req, res, opts).catch(err => {
      console.error('[llmusage] progress endpoint error:', err);
      sendJSON(res, 500, { ok: false, error: 'internal error' });
    });
  });

  const basePort = opts.port ?? DEFAULT_PORT;
  const port = await listenWithFallback(server, basePort);
  const url = `http://${HOST}:${port}`;
  const endpointFile = opts.endpointFile === undefined ? DEFAULT_ENDPOINT_FILE : opts.endpointFile;
  if (endpointFile) await writeEndpointFile(endpointFile, port, url, opts.version);

  return {
    port,
    url,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (endpointFile) await unlink(endpointFile).catch(() => {});
    },
  };
}

function listenWithFallback(server: Server, basePort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (port: number): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempt < PORT_ATTEMPTS - 1) {
          attempt++;
          tryPort(basePort + attempt);
          return;
        }
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        // Read the bound port back: with port 0 the OS picks one.
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, HOST);
    };
    tryPort(basePort);
  });
}

/** Discovery file so scripts need not hardcode a port. */
async function writeEndpointFile(path: string, port: number, url: string, version: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ url, port, host: HOST, version, pid: process.pid }, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.error('[llmusage] endpoint file write failed:', err);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: StartOptions): Promise<void> {
  const { store, version } = opts;
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  if (path === '/health' || path === '/') {
    sendJSON(res, 200, { ok: true, app: 'llmusage', version, tasks: store.raw().length });
    return;
  }

  const taskId = path.startsWith('/v1/tasks/') ? decodeURIComponent(path.slice('/v1/tasks/'.length)) : null;
  const isCollection = path === '/v1/tasks';

  if (!isCollection && taskId == null) {
    sendJSON(res, 404, { ok: false, error: `unknown path ${path}` });
    return;
  }

  if (method === 'GET') {
    const view = store.view();
    if (taskId) {
      const found = findInTree(view, taskId);
      if (!found) {
        sendJSON(res, 404, { ok: false, error: `no such task ${taskId}` });
        return;
      }
      sendJSON(res, 200, { ok: true, task: found });
      return;
    }
    sendJSON(res, 200, { ok: true, tasks: url.searchParams.get('flat') ? store.raw() : view });
    return;
  }

  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    if (!isJSONContentType(req)) {
      sendJSON(res, 415, {
        ok: false,
        error: "writes require 'Content-Type: application/json'",
      });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJSONBody(req);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: (err as Error).message });
      return;
    }
    const patch = buildUpsert(body, url.searchParams, taskId);
    if (!patch) {
      sendJSON(res, 400, { ok: false, error: "missing 'id'" });
      return;
    }
    const task = store.upsert(patch);
    sendJSON(res, 200, { ok: true, task: findInTree(store.view(), task.id) ?? task });
    return;
  }

  if (method === 'DELETE') {
    if (taskId) {
      const removed = store.remove(taskId);
      sendJSON(res, removed > 0 ? 200 : 404, { ok: removed > 0, removed });
      return;
    }
    if (url.searchParams.get('finished')) {
      sendJSON(res, 200, { ok: true, removed: store.clearFinished() });
      return;
    }
    sendJSON(res, 400, { ok: false, error: 'DELETE /v1/tasks requires an id or ?finished=1' });
    return;
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  sendJSON(res, 405, { ok: false, error: `${method} not allowed` });
}

/**
 * Merge a JSON body over query params, so both of these work:
 *   -d '{"current":5,"total":100}'
 *   '?current=5&total=100'
 * Body values win. Explicit nulls are preserved (they clear a field).
 */
export function buildUpsert(
  body: Record<string, unknown>,
  params: URLSearchParams,
  pathId: string | null
): TaskUpsert | null {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of params) merged[key] = value;
  for (const [key, value] of Object.entries(body)) merged[key] = value;

  const id = pathId ?? asString(merged.id);
  if (!id) return null;

  const patch: TaskUpsert = { id };
  if (merged.title !== undefined) patch.title = asString(merged.title) ?? id;
  if (merged.parent !== undefined) patch.parent = asString(merged.parent);
  if (merged.status !== undefined) patch.status = asString(merged.status) ?? undefined;
  if (merged.current !== undefined) patch.current = asNumber(merged.current) ?? 0;
  if (merged.total !== undefined) patch.total = asNumber(merged.total);
  if (merged.unit !== undefined) patch.unit = asString(merged.unit);
  if (merged.note !== undefined) patch.note = asString(merged.note);
  if (merged.source !== undefined) patch.source = asString(merged.source);
  if (merged.startedAt !== undefined) patch.startedAt = asString(merged.startedAt) ?? undefined;
  if (merged.etaAt !== undefined) patch.etaAt = asString(merged.etaAt);
  if (merged.ttlSeconds !== undefined) patch.ttlSeconds = asNumber(merged.ttlSeconds) ?? undefined;
  return patch;
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function asNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function isJSONContentType(req: IncomingMessage): boolean {
  const ct = req.headers['content-type'] ?? '';
  return ct.split(';')[0]!.trim().toLowerCase() === 'application/json';
}

async function readJSONBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON body');
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function findInTree<T extends { id: string; children: T[] }>(nodes: T[], id: string): T | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findInTree(node.children, id);
    if (hit) return hit;
  }
  return null;
}

function sendJSON(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
