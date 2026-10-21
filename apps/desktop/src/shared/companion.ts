/**
 * Immersive companion window contract (Phase 7a).
 *
 * The "companion" is a second `BrowserWindow` that shows a single agent at full
 * bleed: 3D/VRM avatar + live voice, like a video call. The main window pops it
 * out; the companion window carries only the *address* of the conversation
 * (contact + optional conversation + agent identity), never a token — the
 * renderer resolves the live session through the same preload bridge.
 *
 * Everything here is pure (hash build/parse) so the launch contract is unit
 * tested without Electron.
 */

/** Default size of the popped-out companion window. */
export const COMPANION_DEFAULT_SIZE = { width: 720, height: 820 } as const;

/** `#companion?...` hash segment identifying the companion route. */
export const COMPANION_HASH_PREFIX = 'companion';

/**
 * Companion presentation mode (Phase 11e):
 * - `fullscreen` — full-window 3D/VRM stage with the realtime voice session;
 * - `split` — the same session, chat beside the 3D stage.
 * Both share one realtime voice mode; only the layout differs.
 */
export type CompanionMode = 'fullscreen' | 'split';

export type CompanionLaunch = {
  contactId: string;
  conversationId?: string | null;
  /** Agent address, when known, so the companion can start a call without a lookup. */
  agentId?: string | null;
  virtualEmployeeId?: string | null;
  title?: string | null;
  avatarUrl?: string | null;
  /** Auto-start the live voice session on open (default true). */
  autoStart?: boolean;
  /** Stage layout; defaults to `fullscreen`. */
  mode?: CompanionMode;
};

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Serialize a launch into a `#companion?...` hash. Only present, non-empty
 * fields are written so the hash stays small and readable.
 */
export function buildCompanionHash(launch: CompanionLaunch): string {
  const params = new URLSearchParams();
  params.set('contactId', launch.contactId);
  const conversationId = clean(launch.conversationId);
  if (conversationId) params.set('conversationId', conversationId);
  const agentId = clean(launch.agentId);
  if (agentId) params.set('agentId', agentId);
  const virtualEmployeeId = clean(launch.virtualEmployeeId);
  if (virtualEmployeeId) params.set('virtualEmployeeId', virtualEmployeeId);
  const title = clean(launch.title);
  if (title) params.set('title', title);
  const avatarUrl = clean(launch.avatarUrl);
  if (avatarUrl) params.set('avatarUrl', avatarUrl);
  if (launch.autoStart === false) params.set('autoStart', '0');
  if (launch.mode === 'split') params.set('mode', 'split');
  return `#${COMPANION_HASH_PREFIX}?${params.toString()}`;
}

/**
 * Parse a `#companion?...` hash back into a launch. Returns `null` for any other
 * route (including the normal `#` app route) or a hash missing `contactId`.
 */
export function parseCompanionHash(hash: string): CompanionLaunch | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const [route, query = ''] = raw.split('?');
  if (route !== COMPANION_HASH_PREFIX) return null;
  const params = new URLSearchParams(query);
  const contactId = clean(params.get('contactId'));
  if (!contactId) return null;
  return {
    contactId,
    conversationId: clean(params.get('conversationId')),
    agentId: clean(params.get('agentId')),
    virtualEmployeeId: clean(params.get('virtualEmployeeId')),
    title: clean(params.get('title')),
    avatarUrl: clean(params.get('avatarUrl')),
    autoStart: params.get('autoStart') !== '0',
    mode: params.get('mode') === 'split' ? 'split' : 'fullscreen',
  };
}

/** Is this renderer URL/hash the companion route? */
export function isCompanionHash(hash: string): boolean {
  return parseCompanionHash(hash) != null;
}
