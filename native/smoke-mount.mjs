#!/usr/bin/env node
/**
 * End-to-end smoke test for the native `nexus-mount` helper.
 *
 * Spins a stub region implementing just the commands the helper calls, writes a
 * session config + token file, and exercises the helper against a **real** FUSE
 * mount: listings, reads, nested sub-directories, writes (journaled), and
 * write-back replay on the next mount.
 *
 * The stub runs in a worker thread: the main thread blocks on FUSE reads
 * (`readFileSync`), so serving the region from the same event loop would
 * deadlock.
 *
 * Skips cleanly (exit 0) when FUSE or the compiled helper is unavailable.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

const helperArg = process.argv[2] ?? 'native/target/release/nexus-mount';
const helper = resolve(process.cwd(), helperArg);

if (!existsSync(helper)) {
  console.log(`[smoke] helper not built at ${helper}; skipping`);
  process.exit(0);
}
if (process.platform !== 'linux' && process.platform !== 'darwin') {
  console.log('[smoke] not a FUSE platform; skipping');
  process.exit(0);
}
if (!existsSync('/dev/fuse')) {
  console.log('[smoke] no /dev/fuse; skipping');
  process.exit(0);
}

// ── stub region, on its own event loop ──────────────────────────────────────
const stubSource = `
const { parentPort } = require('node:worker_threads');
const { createServer } = require('node:http');
const files = {
  f1: { name: 'brief.txt', folderId: 'clients', bytes: Buffer.from('hello from the bucket') },
  f2: { name: 'out.txt', folderId: null, bytes: Buffer.from('outside the sub-dir') },
  f3: { name: 'deep.txt', folderId: 'q3', bytes: Buffer.from('nested under the sub-dir') },
};
const folders = [
  { _id: 'root', name: 'Projects', parentFolderId: null },
  { _id: 'clients', name: 'Clients', parentFolderId: 'root' },
  { _id: 'q3', name: 'Q3', parentFolderId: 'clients' },
];
let nextId = 100;
const initNames = {};
let port = 0;
const server = createServer((req, res) => {
  if (req.url.startsWith('/object/')) {
    const id = req.url.slice('/object/'.length);
    const f = files[id];
    res.writeHead(f ? 200 : 404, { 'content-type': 'application/octet-stream' });
    res.end(f ? f.bytes : '');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const env = JSON.parse(body || '{}');    const reply = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ responseCode: 200, responseObject: obj }));
    };
    switch (env.command) {
      case 'anx.storage.workspace.folder.list':
        return reply({ items: folders });
      case 'anx.storage.bucket.list-files':
        return reply({
          items: Object.entries(files).map(([id, f]) => ({
            _id: id, originalName: f.name, folderId: f.folderId,
            sizeBytes: f.bytes.length, revisionNo: 1,
          })),
        });
      case 'anx.storage.presign.get':
        return reply({ url: 'http://127.0.0.1:' + port + '/object/' + env.payload.fileId });
      case 'anx.file.upload-init': {
        const id = 'up-' + nextId++;
        initNames[id] = env.payload.originalName;
        return reply({ fileId: id, presignPut: false });
      }
      case 'anx.file.upload-complete': {
        const bytes = Buffer.from(env.payload.base64Data || '', 'base64');
        const name = initNames[env.payload.fileId] || 'unknown';
        files['up'] = { name, folderId: 'clients', bytes };
        // Let the test observe that a queued local edit reached the region.
        parentPort.postMessage({ event: 'upload', name, text: bytes.toString('utf8') });
        return reply({ file: { _id: 'up', originalName: name } });
      }
      case 'anx.storage.bucket.trash-file':
        return reply({});
      default:
        return reply({});
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  port = server.address().port;
  parentPort.postMessage({ event: 'ready', port });
});
`;
const worker = new Worker(stubSource, { eval: true });
const uploads = [];
const port = await new Promise((r) =>
  worker.on('message', (m) => {
    if (m.event === 'ready') r(m.port);
    else if (m.event === 'upload') uploads.push(m);
  }),
);

const dir = mkdtempSync(join(tmpdir(), 'nexus-mount-smoke-'));
const mountpoint = join(dir, 'mnt');
const configPath = join(dir, 'session.helper.json');
mkdirSync(mountpoint, { recursive: true });
writeFileSync(join(dir, 'token'), 'test-token', 'utf8');
writeFileSync(
  configPath,
  JSON.stringify({
    mountpoint,
    workspace_id: 'w1',
    remote_folder_id: 'clients',
    remote_folder_path: '/Projects/Clients',
    read_only: false,
    cache_dir: join(dir, 'cache'),
    journal_path: join(dir, 'cache.journal.jsonl'),
    region_url: `http://127.0.0.1:${port}`,
    token_path: join(dir, 'token'),
    volume_name: 'NexusSmoke',
  }),
  'utf8',
);

let failures = 0;
const check = (label, ok) => {
  console.log(`[smoke] ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
};
const start = () => spawn(helper, [configPath], { stdio: ['ignore', 'inherit', 'inherit'] });
const stop = async (child) => {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  spawnSync('fusermount', ['-u', mountpoint]);
  await new Promise((r) => setTimeout(r, 200));
};

try {
  // ── first mount: read + nested structure + write ──────────────────────
  let child = start();
  await new Promise((r) => setTimeout(r, 1500));

  check(
    'reads a file from the bound sub-dir',
    readFileSync(join(mountpoint, 'brief.txt'), 'utf8') === 'hello from the bucket',
  );
  check(
    'preserves nested sub-directory structure',
    readFileSync(join(mountpoint, 'Q3/deep.txt'), 'utf8') === 'nested under the sub-dir',
  );
  check('does not expose files outside the sub-dir', !existsSync(join(mountpoint, 'out.txt')));

  writeFileSync(join(mountpoint, 'note.txt'), 'new content');
  await new Promise((r) => setTimeout(r, 300));
  check('accepts a write', existsSync(join(mountpoint, 'note.txt')));

  const journal = join(dir, 'cache.journal.jsonl');
  check(
    'journals the write for write-back',
    existsSync(journal) && readFileSync(journal, 'utf8').includes('note.txt'),
  );

  await stop(child);

  // ── second mount: the pending edit is replayed to the region ──────────
  check('left the journal for the next mount', existsSync(journal));
  child = start();
  await new Promise((r) => setTimeout(r, 1800));

  const replayed = uploads.filter((u) => u.name === 'note.txt').at(-1);
  check('replays the queued write to the region', replayed?.text === 'new content');
  check(
    'clears the journal after a successful replay',
    readFileSync(journal, 'utf8').trim() === '',
  );

  await stop(child);
} catch (e) {
  console.log(`[smoke] error: ${e.message}`);
  failures += 1;
} finally {
  spawnSync('fusermount', ['-u', mountpoint]);
  await worker.terminate();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '[smoke] PASS' : `[smoke] FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
