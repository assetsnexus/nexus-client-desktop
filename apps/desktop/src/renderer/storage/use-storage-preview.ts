/**
 * Renderer inline preview loading for bucket files.
 *
 * The sandboxed renderer cannot reach the storage host directly (a presigned URL
 * is cross-origin and the CSP is hardened), so **main** streams the real bytes
 * and hands back base64 (`storagePreviewBytes`). This hook turns those bytes into
 * a `blob:` URL typed with the file's MIME so:
 *  - an `<img>` renders an image (the remote URL would also be blocked by
 *    `img-src` for a foreign origin), and
 *  - an `<iframe>` renders a PDF with Chromium's viewer. Pointing the viewer at
 *    the remote URL would *download* it (cross-origin + `Content-Disposition:
 *    attachment`), so bytes are fetched and re-typed deliberately.
 *
 * Every object URL is revoked when the preview changes or unmounts (no leak),
 * and a size guard refuses enormous files up front (`storage-preview.ts`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, type StorageFileRow } from '../bridge.js';
import {
  blobTypeFor,
  canPreview,
  canThumbnail,
  contentKind,
  previewKindFor,
  type PreviewKind,
} from '../../shared/storage-preview.js';

export type PreviewState =
  | { status: 'idle' }
  | { status: 'unsupported' }
  | { status: 'too-large' }
  | { status: 'loading' }
  | { status: 'ready'; url: string; kind: 'image' | 'pdf'; sizeBytes: number; contentType: string }
  | { status: 'unavailable'; reason: string };

/** How many leading bytes to read before rendering, to catch an error body. */
const RENDER_GUARD_HEAD_BYTES = 2048;

/**
 * Load real bytes for a file and wrap them in a revocable object URL.
 *
 * Main already refuses an error body / mismatch, but the renderer keeps its own
 * belt-and-braces check so a body that is really a storage error document can
 * never be rendered as file content (a broken `<img>` or a PDF viewer showing
 * XML). The declared MIME is only honoured when the file's own type allows it.
 */
async function loadObjectUrl(file: StorageFileRow, kind: 'image' | 'pdf'): Promise<string> {
  const res = await bridge.storagePreviewBytes(file.id);
  if (!res.ok) {
    throw new Error(res.tooLarge ? 'too-large' : res.error || 'preview unavailable');
  }
  const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
  if (bytes.byteLength === 0) {
    throw new Error('the storage host returned an empty body');
  }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, RENDER_GUARD_HEAD_BYTES));
  if (contentKind(head, kind) === 'markup-error') {
    throw new Error('the storage host returned an error document instead of the file');
  }
  const contentType = blobTypeFor(kind, file.name, res.contentType || file.mimeType);
  return URL.createObjectURL(new Blob([bytes], { type: contentType }));
}

/**
 * Inline preview for one selected file. `reload` re-fetches after a transient
 * failure; the object URL is revoked on every change/unmount.
 */
export function useStoragePreview(file: StorageFileRow | null): PreviewState & { reload: () => void } {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);
  const urlRef = useRef<string | null>(null);

  const setUrl = useCallback((next: string | null) => {
    if (urlRef.current && urlRef.current !== next) URL.revokeObjectURL(urlRef.current);
    urlRef.current = next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!file) {
      setUrl(null);
      setState({ status: 'idle' });
      return;
    }
    const kind: PreviewKind = previewKindFor(file.name, file.mimeType);
    if (kind === 'none') {
      setUrl(null);
      setState({ status: 'unsupported' });
      return;
    }
    if (!canPreview(kind, file.sizeBytes)) {
      setUrl(null);
      setState({ status: 'too-large' });
      return;
    }
    setState({ status: 'loading' });
    loadObjectUrl(file, kind)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        setUrl(url);
        setState({ status: 'ready', url, kind, sizeBytes: file.sizeBytes, contentType: file.mimeType });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setUrl(null);
        const reason = err instanceof Error ? err.message : 'preview unavailable';
        setState(reason === 'too-large' ? { status: 'too-large' } : { status: 'unavailable', reason });
      });
    return () => {
      cancelled = true;
    };
  }, [file?.id, file?.name, file?.mimeType, file?.sizeBytes, nonce, setUrl]);

  // Final revoke when the hook unmounts.
  useEffect(() => () => setUrl(null), [setUrl]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

/** How many row thumbnails are fetched at once (keeps a page load calm). */
const THUMB_CONCURRENCY = 3;

/**
 * Small image thumbnails for the row list, keyed by file id. Only genuinely
 * small images are fetched (`canThumbnail`), at most `THUMB_CONCURRENCY` at a
 * time; every object URL is revoked when the explorer unmounts.
 */
export function useStorageThumbnails(items: StorageFileRow[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const cache = useRef(new Map<string, string>());
  const pending = useRef(new Set<string>());
  const active = useRef(0);
  const queue = useRef<Array<() => void>>([]);

  useEffect(() => {
    const wanted = items.filter((f) => canThumbnail(previewKindFor(f.name, f.mimeType), f.sizeBytes));

    const pump = () => {
      while (active.current < THUMB_CONCURRENCY && queue.current.length) {
        active.current += 1;
        const task = queue.current.shift()!;
        task();
      }
    };

    for (const file of wanted) {
      if (cache.current.has(file.id) || pending.current.has(file.id)) continue;
      pending.current.add(file.id);
      queue.current.push(() => {
        loadObjectUrl(file, 'image')
          .then((url) => {
            cache.current.set(file.id, url);
            setUrls((cur) => ({ ...cur, [file.id]: url }));
          })
          .catch(() => undefined)
          .finally(() => {
            pending.current.delete(file.id);
            active.current -= 1;
            pump();
          });
      });
    }
    pump();

    return () => {
      // Stop queued work on unmount; completed URLs are revoked below.
      queue.current = [];
    };
  }, [items]);

  useEffect(
    () => () => {
      for (const url of cache.current.values()) URL.revokeObjectURL(url);
      cache.current.clear();
    },
    [],
  );

  return urls;
}
