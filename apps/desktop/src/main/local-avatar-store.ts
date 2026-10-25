/**
 * Persisted local avatar library (main process).
 *
 * Mirrors `local-models-store.ts`: plain JSON in `userData`, everything run back
 * through the shared normalizer so a hand-edited file cannot produce an
 * unusable list. On top of that it *copies* a picked model into the app's own
 * library folder, because a path the user picked can move or be deleted — the
 * library must keep working after the source file is gone.
 *
 * Only add/remove run here; the file copy happens in `main.ts` at the IPC
 * boundary so this module stays a pure store (easily unit tested with a temp
 * dir, no `dialog`).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { app } from 'electron';
import {
  DEFAULT_LOCAL_AVATARS,
  avatarIdSlug,
  avatarKindFromFileName,
  avatarLabelFromFileName,
  isSupportedAvatarFileName,
  normalizeContactMappings,
  normalizeLocalAvatarsConfig,
  removeLocalAvatar as removeAvatarFromConfig,
  type LocalAvatarRecord,
  type LocalAvatarsConfig,
} from '../shared/local-avatars.js';

export type LocalAvatarStore = {
  /** Directory the library files are copied into. */
  libraryDir(): string;
  get(): LocalAvatarsConfig;
  /**
   * Copy a picked file into the library and register it. Throws when the file
   * is missing or not a supported model, or when it is a duplicate of an entry
   * already in the library (same source path + size).
   */
  addFile(sourcePath: string, label?: string): LocalAvatarsConfig;
  /** Remove an entry and delete its copied file (best effort). Returns the config. */
  remove(id: string): LocalAvatarsConfig;
  /** Set (or clear, with `null`) the library avatar one contact is mapped to. */
  setContactMapping(contactId: string, avatarId: string | null): LocalAvatarsConfig;
};

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function createLocalAvatarStore(options?: {
  filePath?: string;
  libraryDir?: string;
}): LocalAvatarStore {
  const path = options?.filePath ?? join(app.getPath('userData'), 'local-avatars.json');
  const libDir = options?.libraryDir ?? join(app.getPath('userData'), 'avatar-library');

  const read = (): LocalAvatarsConfig => {
    if (!existsSync(path)) return { avatars: [], contactMappings: {} };
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      const config = normalizeLocalAvatarsConfig(raw);
      // A file deleted outside the app (user cleaned the folder) is not usable:
      // drop the entry so the gallery never offers a model that cannot load.
      const avatars = config.avatars.filter((a) => existsSync(a.filePath));
      // An explicitly empty library is respected (the user removed everything).
      if (avatars.length === config.avatars.length) return config;
      const known = new Set(avatars.map((a) => a.id));
      const contactMappings: Record<string, string> = {};
      for (const [contactId, avatarId] of Object.entries(config.contactMappings)) {
        if (known.has(avatarId)) contactMappings[contactId] = avatarId;
      }
      return { avatars, contactMappings };
    } catch {
      return { avatars: [], contactMappings: {} };
    }
  };

  const write = (value: LocalAvatarsConfig): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  };

  return {
    libraryDir: () => libDir,

    get: read,

    addFile(sourcePath, label) {
      if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
        throw new Error('A local avatar needs a file.');
      }
      const source = sourcePath.trim();
      if (!existsSync(source)) throw new Error('That file no longer exists.');
      const kind = avatarKindFromFileName(source);
      if (!kind || !isSupportedAvatarFileName(source)) {
        throw new Error('Pick a .vrm or .glb model file.');
      }
      const fileName = source.replace(/\\/g, '/').split('/').pop() || `avatar.${kind}`;
      const current = read();
      const sizeBytes = statSync(source).size;
      // Same source path + size already registered: re-adding would waste a copy
      // and confuse the gallery with an identical twin.
      const duplicate = current.avatars.some(
        (a) => a.fileName === fileName && a.sizeBytes === sizeBytes,
      );
      if (duplicate) throw new Error(`${fileName} is already in your library.`);

      mkdirSync(libDir, { recursive: true });
      const taken = new Set(current.avatars.map((a) => a.id));
      const id = uniqueId(avatarIdSlug(fileName), taken);
      const target = join(libDir, `${id}${extname(fileName).toLowerCase() || `.${kind}`}`);
      copyFileSync(source, target);
      const record: LocalAvatarRecord = {
        id,
        label: (typeof label === 'string' && label.trim() ? label.trim() : '') || avatarLabelFromFileName(fileName),
        kind,
        filePath: target,
        fileName,
        sizeBytes,
        addedAt: Date.now(),
      };
      const next: LocalAvatarsConfig = {
        avatars: [...current.avatars, record],
        contactMappings: current.contactMappings,
      };
      write(next);
      return next;
    },

    remove(id) {
      const current = read();
      const target = current.avatars.find((a) => a.id === id);
      const next = removeAvatarFromConfig(current, id);
      if (next === current) return current;
      write(next);
      // The copied file is ours to clean up; a failure here must not undo the
      // removal the user asked for.
      if (target) {
        try {
          rmSync(target.filePath, { force: true });
        } catch {
          /* the entry is gone from the library either way */
        }
      }
      return next;
    },

    setContactMapping(contactId, avatarId) {
      const key = typeof contactId === 'string' ? contactId.trim() : '';
      if (!key) throw new Error('A contact is required.');
      const current = read();
      const mappings = normalizeContactMappings(current.contactMappings);
      if (avatarId === null) delete mappings[key];
      else {
        const value = avatarId.trim();
        if (!value) delete mappings[key];
        else if (!current.avatars.some((a) => a.id === value)) {
          throw new Error('That avatar is not in your library.');
        } else mappings[key] = value;
      }
      const next: LocalAvatarsConfig = { avatars: current.avatars, contactMappings: mappings };
      write(next);
      return next;
    },
  };
}

export { DEFAULT_LOCAL_AVATARS };
