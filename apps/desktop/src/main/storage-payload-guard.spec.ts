import { describe, expect, it } from 'vitest';
import {
  detectPayloadError,
  expectedMimeForName,
  looksLikeMarkupError,
} from './storage-payload-guard.js';

/** The exact body MinIO returns for a missing object (see the drill). */
const S3_NO_SUCH_KEY =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message>' +
  '<Key>chat-attachment/1789386413041-mus85vk0m.jpg</Key><BucketName>anx-eu-west-free-tier</BucketName>' +
  '<Resource>/anx-eu-west-free-tier/chat-attachment/1789386413041-mus85vk0m.jpg</Resource></Error>';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR42u3NMQEAAAgDoC251a1g' +
    'D0hgblXVvXsAAAAAAAAAAADAzwEfZQABq3VKzQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Size 1>>\n%%EOF\n', 'utf8');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;', 'latin1');

describe('looksLikeMarkupError', () => {
  it('recognises an S3 <Error> document, with or without a declaration', () => {
    expect(looksLikeMarkupError(S3_NO_SUCH_KEY)).toBe(true);
    expect(looksLikeMarkupError('<Error><Code>AccessDenied</Code></Error>')).toBe(true);
    expect(looksLikeMarkupError('  <?xml version="1.0"?>\n<Error><Code>X</Code></Error>')).toBe(true);
  });

  it('recognises an HTML error page', () => {
    expect(looksLikeMarkupError('<html><body>502 Bad Gateway</body></html>')).toBe(true);
    expect(looksLikeMarkupError('<!DOCTYPE html>\n<html><head></head></html>')).toBe(true);
  });

  it('does NOT flag a bare XML declaration (a legitimate SVG may start with it)', () => {
    expect(looksLikeMarkupError('<?xml version="1.0" encoding="UTF-8"?>')).toBe(false);
    expect(looksLikeMarkupError('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe(false);
  });

  it('does not flag ordinary content or empty input', () => {
    expect(looksLikeMarkupError('hello world')).toBe(false);
    expect(looksLikeMarkupError('')).toBe(false);
    expect(looksLikeMarkupError('   ')).toBe(false);
    expect(looksLikeMarkupError('<Text><Error>not at the start</Error>')).toBe(false);
  });
});

describe('detectPayloadError', () => {
  it('flags the S3 XML error body as error-body and reports the Code', () => {
    const verdict = detectPayloadError(Buffer.from(S3_NO_SUCH_KEY, 'utf8'), {
      expectedMime: 'image/jpeg',
      declaredType: 'application/xml',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.kind).toBe('error-body');
      expect(verdict.detail).toContain('NoSuchKey');
    }
  });

  it('still flags an XML error body when the host lies with 200 + a real content type', () => {
    const verdict = detectPayloadError(Buffer.from(S3_NO_SUCH_KEY, 'utf8'), {
      expectedMime: 'image/jpeg',
      declaredType: 'image/jpeg',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.kind).toBe('error-body');
  });

  it('flags an HTML error page served for an image', () => {
    const verdict = detectPayloadError(Buffer.from('<html><body>oops</body></html>', 'utf8'), {
      expectedMime: 'image/png',
      declaredType: 'text/html',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.kind).toBe('error-body');
  });

  it('flags markup served for a binary file even without an <Error> root', () => {
    const verdict = detectPayloadError(Buffer.from('<?xml version="1.0"?><foo/>', 'utf8'), {
      expectedMime: 'application/pdf',
      declaredType: 'application/xml',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.kind).toBe('error-body');
  });

  it('accepts real PNG / JPEG / GIF / PDF bytes', () => {
    expect(detectPayloadError(PNG, { expectedMime: 'image/png', declaredType: 'image/png' })).toEqual({ ok: true });
    expect(detectPayloadError(JPEG, { expectedMime: 'image/jpeg', declaredType: 'image/jpeg' })).toEqual({ ok: true });
    expect(detectPayloadError(GIF, { expectedMime: 'image/gif', declaredType: 'image/gif' })).toEqual({ ok: true });
    expect(detectPayloadError(PDF, { expectedMime: 'application/pdf', declaredType: 'application/pdf' })).toEqual({ ok: true });
  });

  it('flags a body whose magic bytes contradict the expected type', () => {
    const verdict = detectPayloadError(PDF, { expectedMime: 'image/png', declaredType: 'image/png' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.kind).toBe('type-mismatch');
  });

  it('treats a zero-length body as empty only when a type was expected', () => {
    expect(detectPayloadError(Buffer.alloc(0), { expectedMime: 'image/png' })).toMatchObject({
      ok: false,
      kind: 'empty',
    });
    expect(detectPayloadError(Buffer.alloc(0), {})).toEqual({ ok: true });
    expect(detectPayloadError(Buffer.alloc(0), { expectedMime: null, declaredType: 'text/plain' })).toEqual({ ok: true });
  });

  it('accepts a legitimate SVG (markup is not an error for SVG)', () => {
    const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf8');
    expect(detectPayloadError(svg, { expectedMime: 'image/svg+xml', declaredType: 'image/svg+xml' })).toEqual({ ok: true });
  });

  it('flags an SVG that is really a binary body', () => {
    const verdict = detectPayloadError(PDF, { expectedMime: 'image/svg+xml', declaredType: 'image/svg+xml' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.kind).toBe('type-mismatch');
  });

  it('does not guess for an unjudgeable expected type (text/plain etc.)', () => {
    expect(detectPayloadError(Buffer.from('plain text file'), { expectedMime: 'text/plain', declaredType: 'text/plain' })).toEqual({ ok: true });
    expect(detectPayloadError(PNG, { expectedMime: undefined, declaredType: 'image/png' })).toEqual({ ok: true });
  });
});

describe('expectedMimeForName', () => {
  it('maps known previewable extensions', () => {
    expect(expectedMimeForName('photo.PNG')).toBe('image/png');
    expect(expectedMimeForName('a/b/c.jpg')).toBe('image/jpeg');
    expect(expectedMimeForName('scan.pdf')).toBe('application/pdf');
    expect(expectedMimeForName('vector.svg')).toBe('image/svg+xml');
  });

  it('returns undefined for text/archives/unknown so saves are not over-blocked', () => {
    expect(expectedMimeForName('notes.txt')).toBeUndefined();
    expect(expectedMimeForName('archive.zip')).toBeUndefined();
    expect(expectedMimeForName('no-extension')).toBeUndefined();
    expect(expectedMimeForName('')).toBeUndefined();
  });
});
