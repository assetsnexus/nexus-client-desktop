// @vitest-environment jsdom
/**
 * Regression guard for the storage preview honesty rule.
 *
 * A storage download can succeed yet return an **error document** (an XML
 * `<Error><Code>NoSuchKey</Code></Error>` body, an HTML gateway page) instead of
 * the file. The renderer must never turn that into a broken `<img>` or a PDF
 * viewer showing XML: it must degrade to "unavailable". This test renders the
 * REAL `useStoragePreview` hook against a fake bridge and asserts the three
 * contract cases — an error body is unavailable, a zero-length body is
 * unavailable, and real bytes reach `ready`.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  previewBytes: vi.fn(),
}));

vi.mock('../bridge.js', () => ({
  bridge: {
    storagePreviewBytes: (fileId: string) => h.previewBytes(fileId),
  },
}));

import { useStoragePreview, type PreviewState } from './use-storage-preview.js';
import type { StorageFileRow } from '../bridge.js';

const S3_NO_SUCH_KEY =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message>' +
  '<Key>chat-attachment/1789386413041-mus85vk0m.jpg</Key></Error>';

const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR42u3NMQEAAAgDoC251a1g' +
      'D0hgblXVvXsAAAAAAAAAAADAzwEfZQABq3VKzQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

const file = (over: Partial<StorageFileRow> = {}): StorageFileRow => ({
  id: 'file-1',
  name: 'ai_dragon.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 84291,
  status: 'ready',
  workspaceId: 'ws',
  folderId: null,
  encryptionTier: 'region',
  createdAt: null,
  revisionNo: null,
  ...over,
});

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

let latest: PreviewState | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Harness(): null {
  latest = useStoragePreview(file());
  return null;
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  latest = null;
  h.previewBytes.mockReset();
  (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:preview');
  (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

async function mountAndSettle(): Promise<void> {
  await act(async () => {
    root!.render(createElement(Harness));
  });
  // Let the promise chain in the effect resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useStoragePreview honesty guard', () => {
  it('turns an S3 XML error body into "unavailable", not a broken image', async () => {
    h.previewBytes.mockResolvedValue({
      ok: true,
      base64: toBase64(new TextEncoder().encode(S3_NO_SUCH_KEY)),
      contentType: 'application/xml',
      sizeBytes: S3_NO_SUCH_KEY.length,
    });
    await mountAndSettle();
    expect(latest?.status).toBe('unavailable');
    if (latest?.status === 'unavailable') {
      expect(latest.reason).toMatch(/error document/i);
    }
  });

  it('turns a zero-length body into "unavailable"', async () => {
    h.previewBytes.mockResolvedValue({ ok: true, base64: '', contentType: 'image/jpeg', sizeBytes: 0 });
    await mountAndSettle();
    expect(latest?.status).toBe('unavailable');
    if (latest?.status === 'unavailable') expect(latest.reason).toMatch(/empty/i);
  });

  it('renders real image bytes', async () => {
    h.previewBytes.mockResolvedValue({
      ok: true,
      base64: toBase64(PNG),
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
    });
    await mountAndSettle();
    expect(latest?.status).toBe('ready');
    if (latest?.status === 'ready') expect(latest.kind).toBe('image');
  });

  it('surfaces main-refused bytes as unavailable with the reason', async () => {
    h.previewBytes.mockResolvedValue({ ok: false, error: 'the storage host returned an error document (NoSuchKey)' });
    await mountAndSettle();
    expect(latest?.status).toBe('unavailable');
    if (latest?.status === 'unavailable') expect(latest.reason).toContain('NoSuchKey');
  });
});
