/**
 * Inline preview policy (pure, framework-free).
 *
 * Decides whether a bucket file should render as an **image** or a **PDF** in
 * the explorer, and whether it is small enough to preview at all. Kept pure so
 * the type rules and the size guard are unit-testable without a renderer or a
 * running region.
 *
 * Type is resolved from BOTH signals, never invented:
 *  - the region returns a real `mimeType` (mapped from the file record's
 *    `contentType`, see `@nexus/storage-browser`'s `parseFileRecord`), and
 *  - the file **extension**, which is what the OS/browser would use and is the
 *    only signal for a record whose stored type is generic.
 * A concrete `image/*` / `application/pdf` MIME wins; otherwise the extension
 * decides. Anything else stays on the existing icon/placeholder path.
 */

export type PreviewKind = 'image' | 'pdf' | 'none';

/** Bytes above this are not previewed inline (a blob copy of a huge file would
 * pin memory in the renderer for no benefit). The user can still Save/Download. */
export const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

/** Row thumbnails are only worth fetching for genuinely small images. */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg']);

/** Lower-case extension without the dot (`''` when there is none). */
export function extensionOf(name: string): string {
  const base =
    String(name ?? '')
      .split(/[/\\]/)
      .pop()
      ?.trim() ?? '';
  const dot = base.lastIndexOf('.');
  // A leading dot (dotfile) is not an extension; e.g. `.bashrc` -> ''.
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * How a file should be previewed. `mimeType` is the region-returned type and
 * may be a generic `application/octet-stream`; the extension is then the
 * deciding signal.
 */
export function previewKindFor(name: string, mimeType: string | null | undefined): PreviewKind {
  const type = String(mimeType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';

  const ext = extensionOf(name);
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'none';
}

/** A MIME type to build the renderer `blob:` URL with. */
export function blobTypeFor(kind: PreviewKind, name: string, mimeType?: string | null): string {
  const served = String(mimeType ?? '')
    .split(';')[0]
    .trim();
  if (served && served !== 'application/octet-stream') return served;
  const ext = extensionOf(name);
  if (kind === 'pdf' || ext === 'pdf') return 'application/pdf';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'avif':
      return 'image/avif';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

/** True when inline previewing is allowed for this kind + size. */
export function canPreview(kind: PreviewKind, sizeBytes: number): boolean {
  if (kind === 'none') return false;
  return !Number.isFinite(sizeBytes) || sizeBytes <= PREVIEW_MAX_BYTES;
}

/** True when a row thumbnail is worthwhile (small image only). */
export function canThumbnail(kind: PreviewKind, sizeBytes: number): boolean {
  return kind === 'image' && sizeBytes > 0 && sizeBytes <= THUMBNAIL_MAX_BYTES;
}

/**
 * What a preview's bytes actually are, judged from the (already length-checked)
 * leading text. A storage error is a *document*, not the file: an XML
 * `<Error><Code>…</Code></Error>` body or an HTML gateway page can arrive with
 * a successful status. When the bytes are markup but the file is not, the caller
 * must treat the preview as unavailable rather than render it — this is the
 * renderer-side half of the main-process payload guard.
 *
 * Deliberately conservative: a lone `<?xml …?>` declaration is *content* (an SVG
 * may start with one), so only a real document root is flagged.
 */
export function contentKind(head: string, kind: PreviewKind): 'text' | 'markup-error' {
  if (kind === 'none') return 'text';
  const stripped = String(head ?? '')
    .replace(/^\uFEFF/, '')
    .trimStart();
  const body = stripped.replace(/^<\?xml[\s\S]*?\?>/i, '').trimStart();
  if (/^<(?:Error|html)[\s>]/i.test(body)) return 'markup-error';
  if (/^<!doctype\s+html[\s>]/i.test(body)) return 'markup-error';
  return 'text';
}
