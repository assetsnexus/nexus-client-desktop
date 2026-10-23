/**
 * Storage payload guard (main process).
 *
 * A storage download can come back **successfully** yet not be the file at all.
 * When a bucket object is missing, the object store answers `404` with an XML
 * `<Error><Code>NoSuchKey</Code>` document; a proxy, a stale file record, or a
 * mis-mapped bucket can surface the same body with HTTP `200`, or serve an
 * `application/xml` / `text/html` page. Handing those bytes straight to the UI
 * produces a broken `<img>`, a PDF viewer rendering XML text, or a corrupt file
 * silently written to the user's disk.
 *
 * This module is the honesty gate in front of both boundaries (inline preview
 * bytes and save/download). It decides whether a response body is plausibly the
 * real file — by declared type, magic bytes, and length — and when it is not,
 * it describes *what* came back (`error-body` + the S3 `Code`/`Message`) so the
 * UI can say so plainly instead of pretending. Kept pure and framework-free so
 * every rule is unit-testable without a renderer or a live region.
 */

/** How many leading bytes to scan for a markup error document. */
export const MARKUP_SCAN_BYTES = 4096;

export type PayloadFailureKind = 'empty' | 'error-body' | 'type-mismatch';

export type PayloadVerdict =
  | { ok: true }
  | { ok: false; kind: PayloadFailureKind; detail: string };

export type PayloadCheckInput = {
  /** MIME the caller expects from the file's record/name. Omitted = unknown. */
  expectedMime?: string | null;
  /** Content-Type the storage host actually served. */
  declaredType?: string | null;
};

/** Lower-case a `Content-Type`-ish value, dropping any `; charset=` suffix. */
function normalizeMime(value: string | null | undefined): string {
  return String(value ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/** Types that are markup by nature (an error page, not a file body). */
function isMarkupType(mime: string): boolean {
  return mime === 'application/xml' || mime === 'text/xml' || mime === 'text/html' || mime.endsWith('+xml');
}

/**
 * Types whose bytes have a strong, checkable signature. SVG is deliberately
 * excluded: it *is* markup, so a markup-root check would be self-defeating.
 */
function isBinaryMedia(mime: string): boolean {
  if (mime === 'application/pdf') return true;
  return mime.startsWith('image/') && mime !== 'image/svg+xml';
}

/**
 * Does this text look like an error *document* rather than file content?
 *
 * Deliberately tight: it must begin (after an optional XML declaration) with an
 * `<Error>`/`<html>` root or an HTML doctype. A lone `<?xml …?>` declaration is
 * **not** flagged on its own, because a legitimate SVG may start that way.
 */
export function looksLikeMarkupError(text: string): boolean {
  const head = String(text ?? '').slice(0, MARKUP_SCAN_BYTES).replace(/^\uFEFF/, '').trimStart();
  if (!head) return false;
  const body = head.replace(/^<\?xml[\s\S]*?\?>/i, '').trimStart();
  return /^<(?:Error|html)[\s>]/i.test(body) || /^<!doctype\s+html[\s>]/i.test(body);
}

/** Pull the S3 `Code` / `Message` out of an error document for a clear reason. */
function describeMarkupError(head: string, declared: string): string {
  const code = /<Code>\s*([^<]{1,80})\s*<\/Code>/i.exec(head)?.[1]?.trim();
  const message = /<Message>\s*([^<]{1,200})\s*<\/Message>/i.exec(head)?.[1]?.trim();
  if (code) {
    return `the storage host returned an error document (${code}${message ? `: ${message}` : ''}) instead of the file`;
  }
  const label = declared ? `${declared} document` : 'XML/HTML document';
  return `the storage host returned a ${label} instead of the file`;
}

type Signature = (buf: Buffer) => boolean;

const latin1 = (buf: Buffer, start: number, end: number): string => buf.subarray(start, end).toString('latin1');

/** Magic-byte checks keyed by the expected MIME type. */
const SIGNATURES: Record<string, Signature> = {
  'image/png': (b) =>
    b.byteLength >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  'image/jpeg': (b) => b.byteLength >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => latin1(b, 0, 6) === 'GIF87a' || latin1(b, 0, 6) === 'GIF89a',
  'image/bmp': (b) => b.byteLength >= 2 && b[0] === 0x42 && b[1] === 0x4d,
  'image/webp': (b) => b.byteLength >= 12 && latin1(b, 0, 4) === 'RIFF' && latin1(b, 8, 12) === 'WEBP',
  'image/avif': (b) =>
    b.byteLength >= 12 &&
    latin1(b, 4, 8) === 'ftyp' &&
    ['avif', 'avis', 'mif1', 'msf1', 'heic', 'heix'].includes(latin1(b, 8, 12)),
  'application/pdf': (b) => latin1(b, 0, 5) === '%PDF-',
};

/**
 * Decide whether a fully-buffered body is safe to treat as the file.
 *
 * Signals, in order:
 *  1. zero length → `empty` (when a type was expected),
 *  2. a markup error document or a markup `Content-Type` → `error-body`,
 *  3. magic bytes that contradict a known expected type → `type-mismatch`.
 *
 * With no `expectedMime` and a non-markup declared type the body is accepted:
 * for an unknown type we cannot honestly judge, so we do not guess.
 */
export function detectPayloadError(buf: Buffer, input: PayloadCheckInput = {}): PayloadVerdict {
  const expected = normalizeMime(input.expectedMime);
  const declared = normalizeMime(input.declaredType);
  const expectsBinary = isBinaryMedia(expected);

  if (buf.byteLength === 0) {
    if (!expected) return { ok: true };
    return { ok: false, kind: 'empty', detail: `the storage host returned an empty body (expected ${expected})` };
  }

  const head = buf.subarray(0, MARKUP_SCAN_BYTES).toString('utf8');
  // Only run the markup check when we have a reason to expect non-markup bytes:
  // a concrete expected type, or a server that itself declared markup.
  if ((expected || isMarkupType(declared)) && looksLikeMarkupError(head)) {
    return { ok: false, kind: 'error-body', detail: describeMarkupError(head, declared) };
  }

  if (expectsBinary && isMarkupType(declared)) {
    return {
      ok: false,
      kind: 'error-body',
      detail: `the storage host served '${declared}' for a ${expected} file`,
    };
  }

  const signature = expectsBinary ? SIGNATURES[expected] : undefined;
  if (signature && !signature(buf)) {
    return { ok: false, kind: 'type-mismatch', detail: `the body does not look like ${expected} data` };
  }

  if (expected === 'image/svg+xml') {
    const stripped = head.replace(/^\uFEFF/, '').trimStart();
    if (!stripped.startsWith('<')) {
      return { ok: false, kind: 'type-mismatch', detail: 'the body does not look like SVG markup' };
    }
  }

  return { ok: true };
}

/**
 * The expected MIME for a **save** from the file's name alone (main often only
 * has the suggested name). `undefined` for anything we cannot judge safely
 * (text, archives, …) so the caller does not over-block a legitimate file.
 */
export function expectedMimeForName(name: string): string | undefined {
  const base = String(name ?? '').trim();
  if (!base) return undefined;
  const ext = base.split(/[/\\]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'svg':
      return 'image/svg+xml';
    case 'pdf':
      return 'application/pdf';
    default:
      return undefined;
  }
}
