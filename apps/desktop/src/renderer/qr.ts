/**
 * QR rendering for the signal/verification codes rendered in the renderer.
 *
 * Uses the `qrcode` library's browser build (no Node `fs`/`zlib`), emitting an
 * inline SVG string we can drop straight into the DOM. Kept tiny on purpose:
 * the only QR we render today is the cross-device login verification URL.
 */

import QRCode from 'qrcode';

/**
 * Render `text` as an inline SVG string. `dark`/`light` keep the code readable
 * against the dark desktop card while staying high-contrast for scanners.
 */
export async function renderQrSvg(
  text: string,
  opts: { size?: number; dark?: string; light?: string } = {},
): Promise<string> {
  return QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: opts.size ?? 220,
    color: {
      dark: opts.dark ?? '#0f1419',
      light: opts.light ?? '#e8eef4',
    },
  });
}
