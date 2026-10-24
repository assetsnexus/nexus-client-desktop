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

/**
 * Default size of the popped-out companion window.
 *
 * Deliberately *small* and album-like (a phone-shaped side companion), not a
 * full app instance — the main window still owns the full chat chrome. Users can
 * resize down to {@link COMPANION_MIN_SIZE}.
 */
export const COMPANION_DEFAULT_SIZE = { width: 560, height: 740 } as const;

/** Smallest sensible companion (keeps the avatar + expandable chat usable). */
export const COMPANION_MIN_SIZE = { width: 380, height: 480 } as const;

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
  /**
   * Draw above other windows (an "always-on-top style" side companion). Default
   * `false` so the app never surprises the user; the companion header exposes a
   * pin toggle that flips this live.
   */
  alwaysOnTop?: boolean;
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
  if (launch.alwaysOnTop === true) params.set('onTop', '1');
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
    alwaysOnTop: params.get('onTop') === '1',
  };
}

/** Is this renderer URL/hash the companion route? */
export function isCompanionHash(hash: string): boolean {
  return parseCompanionHash(hash) != null;
}

/**
 * Live activation pushed into an *already open* companion window (main →
 * companion renderer). Sent over a channel rather than a reload, so a wake that
 * addresses an agent whose companion is already up does not tear down its live
 * voice session.
 *
 * Carries only routing addresses + a capture hint — never a token.
 */
export type CompanionPresent = {
  contactId: string;
  /** The conversation the wake resolved to, so the composer targets it. */
  conversationId: string | null;
  agentId: string | null;
  /** The wake phrase that addressed this agent, for a "heard 'X'" caption. */
  phrase: string | null;
  /**
   * True when this wake wants the companion to own dictation (the wake target
   * surface): it shows the live STT preview + composer and keeps voice mode as a
   * toggle. False leaves the companion's realtime call untouched.
   */
  dictate: boolean;
  /** Bumped once per wake, so the companion can reset per-activation state. */
  token: number;
};

/** Wake dictation lifecycle, mirrored into the companion strip. */
export type CompanionSessionStatus =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'review'
  | 'submitted'
  | 'discarded'
  | 'queued'
  | 'error';

/**
 * Renderer-safe projection of the main renderer's wake dictation session, pushed
 * to the companion window so it can render the live STT preview + composer. The
 * session itself keeps running in the main renderer (which owns the shared mic
 * graph and the pre-roll), so both surfaces observe one capture, not two.
 */
export type CompanionSessionView = {
  contactId: string;
  status: CompanionSessionStatus;
  /** `buffer` + live `partial`, ready to display. */
  preview: string;
  /** Committed text only (what a manual edit replaces). */
  buffer: string;
  /** True when this turn's dictation streams audio to the cloud. */
  cloudTranscription: boolean;
  /** Accumulated audio-batch length, ms (for the "send as voice" action). */
  batchDurationMs: number;
  batchAvailable: boolean;
  sendingAudio: boolean;
  /** Non-fatal reason copy (mic unavailable, send failed, …). */
  message: string | null;
  /** Which engine feeds the preview ("On-device" / "Region inference"). */
  engineLabel: string | null;
  /** The agent name, for the strip's caption. */
  agentName: string | null;
};

/** A control the companion strip sends back to the main renderer's session. */
export type CompanionAction = {
  contactId: string;
  /** `edit` replaces the buffer; `submit`/`cancel`/`sendAudio` drive the session. */
  action: 'submit' | 'cancel' | 'sendAudio' | 'edit';
  /** New text, for `edit` only. */
  text?: string;
};
