/**
 * Companion camera framing presets (shared/main + renderer + library bridge).
 *
 * The 3D camera is owned inside `character-kit` (a `PerspectiveCamera` built by
 * `CharacterController` for the flat stage and by `SceneRoom` for the walkable
 * scene), so a preset cannot be threaded from React alone — it has to be applied
 * on the live host. This module is the **pure**, Three.js-free half: the preset
 * table, the effective framing shape, and a clamped normalizer, mirroring
 * `companion-placement.ts` (`COMPANION_SIZE_PRESETS` / `normalizeCompanionWindowSize`).
 *
 * A preset resolves to concrete camera numbers (distance / height / pitch / FOV)
 * so the library side only has to place one camera — no per-preset logic lives
 * in `character-kit`.
 */

/**
 * Named framings from a tight face close-up to the full body, plus `custom` for
 * an exact dial-in. `bust` is the app default and matches the library's current
 * framing so an unset value is a no-op.
 */
export type CompanionCameraPreset = 'face' | 'bust' | 'full-body' | 'custom';

export type CompanionCamera = {
  preset: CompanionCameraPreset;
  /** Camera distance from the avatar, in metres. */
  distanceM: number;
  /** Camera height above the ground, in metres. */
  heightM: number;
  /**
   * Downward tilt of the camera toward the avatar, in degrees (positive = the
   * camera sits above and looks down). `0` keeps the lens level.
   */
  pitchDeg: number;
  /** Vertical field of view, in degrees. */
  fovDeg: number;
};

/**
 * Preset framing values. `bust` mirrors the long-standing flat-stage framing
 * (camera at `orbitFocusY + 0.25`, ~2.2 m out, 30° FOV) so the default is
 * visually unchanged; the others scale distance/FOV around it.
 */
export const COMPANION_CAMERA_PRESETS: Record<
  Exclude<CompanionCameraPreset, 'custom'>,
  Omit<CompanionCamera, 'preset'>
> = {
  // Tight head/face close-up: close in, narrow lens, slight downward tilt.
  face: { distanceM: 1.15, heightM: 1.68, pitchDeg: 6, fovDeg: 24 },
  // The default: head-and-shoulders, matching the current stage framing.
  bust: { distanceM: 2.2, heightM: 1.95, pitchDeg: 4, fovDeg: 30 },
  // Full body: further back, wider lens so the whole avatar fits.
  'full-body': { distanceM: 3.6, heightM: 1.35, pitchDeg: 2, fovDeg: 38 },
};

export const COMPANION_CAMERA_PRESET_IDS: readonly CompanionCameraPreset[] = [
  'face',
  'bust',
  'full-body',
  'custom',
];

export const COMPANION_CAMERA_MIN_M = 0.5;
export const COMPANION_CAMERA_MAX_M = 12;
export const COMPANION_CAMERA_MIN_PITCH_DEG = -30;
export const COMPANION_CAMERA_MAX_PITCH_DEG = 45;
export const COMPANION_CAMERA_MIN_FOV_DEG = 15;
export const COMPANION_CAMERA_MAX_FOV_DEG = 70;

export const DEFAULT_COMPANION_CAMERA: CompanionCamera = {
  preset: 'bust',
  ...COMPANION_CAMERA_PRESETS.bust,
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  // Keep one decimal for the metre values, whole degrees for the angles.
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}

function isPreset(value: unknown): value is CompanionCameraPreset {
  return (
    typeof value === 'string' &&
    (COMPANION_CAMERA_PRESET_IDS as readonly string[]).includes(value)
  );
}

/**
 * Coerce a persisted/patched camera block into an effective framing.
 *
 * A named preset always resolves to its canonical numbers (so a stale persisted
 * distance cannot drift from the preset the user picked); `custom` takes the
 * stored values, clamped into the allowed range. An unknown preset falls back to
 * the app default.
 */
export function normalizeCompanionCamera(raw: unknown): CompanionCamera {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const preset = isPreset(value.preset) ? value.preset : DEFAULT_COMPANION_CAMERA.preset;
  if (preset === 'custom') {
    return {
      preset,
      distanceM: clampNumber(
        value.distanceM,
        DEFAULT_COMPANION_CAMERA.distanceM,
        COMPANION_CAMERA_MIN_M,
        COMPANION_CAMERA_MAX_M,
      ),
      heightM: clampNumber(
        value.heightM,
        DEFAULT_COMPANION_CAMERA.heightM,
        COMPANION_CAMERA_MIN_M,
        COMPANION_CAMERA_MAX_M,
      ),
      pitchDeg: clampNumber(
        value.pitchDeg,
        DEFAULT_COMPANION_CAMERA.pitchDeg,
        COMPANION_CAMERA_MIN_PITCH_DEG,
        COMPANION_CAMERA_MAX_PITCH_DEG,
      ),
      fovDeg: clampNumber(
        value.fovDeg,
        DEFAULT_COMPANION_CAMERA.fovDeg,
        COMPANION_CAMERA_MIN_FOV_DEG,
        COMPANION_CAMERA_MAX_FOV_DEG,
      ),
    };
  }
  return { preset, ...COMPANION_CAMERA_PRESETS[preset] };
}

/**
 * Effective framing for a preset. A named preset ignores the stored numbers
 * (they are derived), matching {@link normalizeCompanionCamera}.
 */
export function resolveCompanionCamera(camera: CompanionCamera): CompanionCamera {
  if (camera.preset === 'custom') return camera;
  return { preset: camera.preset, ...COMPANION_CAMERA_PRESETS[camera.preset] };
}

/**
 * Library-facing pose: what the host needs to place its camera, resolved against
 * the avatar's head height. Pure so the mapping (preset → host arguments) is
 * unit-testable without building a scene.
 */
export type CompanionCameraPose = {
  distanceM: number;
  /** Absolute camera height in metres (already resolved, not a head offset). */
  heightM: number;
  /** Downward tilt toward the avatar, in radians. */
  pitchRad: number;
  /** Vertical FOV in degrees for `PerspectiveCamera.fov`. */
  fovDeg: number;
};

export function companionCameraPose(camera: CompanionCamera): CompanionCameraPose {
  const resolved = resolveCompanionCamera(camera);
  return {
    distanceM: resolved.distanceM,
    heightM: resolved.heightM,
    pitchRad: (resolved.pitchDeg * Math.PI) / 180,
    fovDeg: resolved.fovDeg,
  };
}
