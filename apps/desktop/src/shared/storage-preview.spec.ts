import { describe, expect, it } from 'vitest';
import {
  PREVIEW_MAX_BYTES,
  THUMBNAIL_MAX_BYTES,
  blobTypeFor,
  canPreview,
  canThumbnail,
  contentKind,
  extensionOf,
  previewKindFor,
} from './storage-preview.js';

describe('extensionOf', () => {
  it('returns the lower-cased extension without the dot', () => {
    expect(extensionOf('photo.PNG')).toBe('png');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('/tmp/deep/notes.MD')).toBe('md');
  });

  it('returns empty for a name with no extension', () => {
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('no-trailing-dot.')).toBe('');
  });

  it('does not treat a dotfile as an extension', () => {
    expect(extensionOf('.bashrc')).toBe('');
    expect(extensionOf('.env')).toBe('');
  });

  it('is robust to path separators and null-ish input', () => {
    expect(extensionOf('C:\\Users\\me\\pic.jpeg')).toBe('jpeg');
    expect(extensionOf('')).toBe('');
    expect(extensionOf(undefined as unknown as string)).toBe('');
  });
});

describe('previewKindFor', () => {
  it('prefers a concrete region mime type', () => {
    // A stored type of image/png wins even when the name lies about it.
    expect(previewKindFor('weird.bin', 'image/png')).toBe('image');
    expect(previewKindFor('weird.bin', 'application/pdf')).toBe('pdf');
    // ...and unsupported concrete types stay unsupported regardless of extension.
    expect(previewKindFor('notes.txt', 'text/plain')).toBe('none');
  });

  it('ignores a mime type parameter suffix and casing', () => {
    expect(previewKindFor('x', 'IMAGE/JPEG; charset=binary')).toBe('image');
    expect(previewKindFor('x', 'Application/PDF')).toBe('pdf');
  });

  it('falls back to the extension when the region type is generic', () => {
    expect(previewKindFor('holiday.JPG', 'application/octet-stream')).toBe('image');
    expect(previewKindFor('report.pdf', null)).toBe('pdf');
    expect(previewKindFor('anim.webp', undefined)).toBe('image');
    expect(previewKindFor('vector.svg', 'binary/octet-stream')).toBe('image');
  });

  it('returns none for unsupported / unknown files', () => {
    expect(previewKindFor('notes.txt', 'text/plain')).toBe('none');
    expect(previewKindFor('no-extension', null)).toBe('none');
    expect(previewKindFor('archive.zip', 'application/zip')).toBe('none');
    expect(previewKindFor('clip.mp4', 'video/mp4')).toBe('none');
  });
});

describe('blobTypeFor', () => {
  it('re-uses the served content type when it is meaningful', () => {
    expect(blobTypeFor('image', 'photo.png', 'image/png')).toBe('image/png');
    expect(blobTypeFor('pdf', 'doc.pdf', 'application/pdf')).toBe('application/pdf');
  });

  it('maps from the extension when the served type is generic or absent', () => {
    expect(blobTypeFor('image', 'photo.jpeg', 'application/octet-stream')).toBe('image/jpeg');
    expect(blobTypeFor('image', 'photo.jpg', null)).toBe('image/jpeg');
    expect(blobTypeFor('image', 'logo.svg', undefined)).toBe('image/svg+xml');
    expect(blobTypeFor('pdf', 'paper', null)).toBe('application/pdf');
  });

  it('falls back to octet-stream for an unknown extension', () => {
    expect(blobTypeFor('image', 'mystery', null)).toBe('application/octet-stream');
  });
});

describe('size guards', () => {
  it('previews images/PDFs at or under the limit and refuses larger ones', () => {
    expect(canPreview('image', PREVIEW_MAX_BYTES)).toBe(true);
    expect(canPreview('pdf', PREVIEW_MAX_BYTES + 1)).toBe(false);
    // A size the region did not report is not a reason to refuse.
    expect(canPreview('image', NaN)).toBe(true);
  });

  it('never previews unsupported kinds, whatever the size', () => {
    expect(canPreview('none', 1)).toBe(false);
  });

  it('only thumbnails small images', () => {
    expect(canThumbnail('image', 1024)).toBe(true);
    expect(canThumbnail('image', THUMBNAIL_MAX_BYTES)).toBe(true);
    expect(canThumbnail('image', THUMBNAIL_MAX_BYTES + 1)).toBe(false);
    expect(canThumbnail('image', 0)).toBe(false);
    expect(canThumbnail('pdf', 1024)).toBe(false);
    expect(canThumbnail('none', 1024)).toBe(false);
  });
});

describe('contentKind', () => {
  it('flags an XML <Error> body and an HTML page as a markup error', () => {
    expect(contentKind('<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>NoSuchKey</Code></Error>', 'image')).toBe('markup-error');
    expect(contentKind('<Error><Code>AccessDenied</Code></Error>', 'pdf')).toBe('markup-error');
    expect(contentKind('<html><body>502</body></html>', 'image')).toBe('markup-error');
    expect(contentKind('<!DOCTYPE html>\n<html></html>', 'pdf')).toBe('markup-error');
  });

  it('treats a bare XML declaration or plain text as content (an SVG may start with one)', () => {
    expect(contentKind('<?xml version="1.0"?>', 'image')).toBe('text');
    expect(contentKind('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>', 'image')).toBe('text');
    expect(contentKind('not markup', 'pdf')).toBe('text');
    expect(contentKind('', 'image')).toBe('text');
  });

  it('does not judge an unsupported preview kind', () => {
    expect(contentKind('<?xml version="1.0"?>\n<Error><Code>X</Code></Error>', 'none')).toBe('text');
  });
});
