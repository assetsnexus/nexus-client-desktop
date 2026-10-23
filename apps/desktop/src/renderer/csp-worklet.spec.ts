import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The 3D avatar lip-sync rail (`@nexus/character-kit` → `three-vrm-lip-sync` →
 * `wlipsync`) registers its MFCC classifier as an **AudioWorklet**. Chromium
 * loads AudioWorklet code as a script, so it is governed by `script-src`; the
 * `blob:` / `data:` variants the engine uses are only allowed when the policy
 * grants them. Without them `audioWorklet.addModule(...)` fails with
 * `AbortError: The user aborted a request.` (a CSP refusal, not a real abort),
 * `VRMLipSync.create` never resolves, and no viseme expression is ever written —
 * the avatar renders but the mouth never moves.
 *
 * Guard the exact source in `src/renderer/index.html` so a future CSP edit
 * cannot silently re-break live lip-sync.
 */
const indexPath = fileURLToPath(new URL('./index.html', import.meta.url));
const html = readFileSync(indexPath, 'utf8');

function directive(name: string): string {
  const match = html.match(new RegExp(`${name}\\s+([^;]+);`));
  return match ? match[1].trim() : '';
}

describe('renderer CSP (AudioWorklet lip-sync)', () => {
  it('declares a Content-Security-Policy that pins script-src', () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(directive('script-src')).not.toBe('');
  });

  it('allows blob: AudioWorklet modules (wlipsync processor)', () => {
    expect(directive('script-src').split(/\s+/)).toContain('blob:');
  });

  it('allows data: AudioWorklet modules (wlipsync base64 fallback)', () => {
    expect(directive('script-src').split(/\s+/)).toContain('data:');
  });

  it('does not resort to a broad wildcard script-src', () => {
    const tokens = directive('script-src').split(/\s+/);
    expect(tokens).not.toContain('*');
    expect(tokens).not.toContain('http:');
    expect(tokens).not.toContain('https:');
    expect(tokens).not.toContain("'unsafe-inline'");
  });

  it('keeps object-src locked down', () => {
    expect(directive('object-src')).toBe("'none'");
  });
});
