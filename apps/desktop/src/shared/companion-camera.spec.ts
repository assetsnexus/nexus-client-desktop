/**
 * Companion camera framing presets — pure geometry + normalizer. The values feed
 * `CharacterController.setCameraPreset` / `SceneRoom.setCameraPreset` via the
 * desktop, so a wrong clamp or a bad pitch sign shows up as a broken framing.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPANION_CAMERA_MAX_FOV_DEG,
  COMPANION_CAMERA_MAX_M,
  COMPANION_CAMERA_MAX_PITCH_DEG,
  COMPANION_CAMERA_MIN_FOV_DEG,
  COMPANION_CAMERA_MIN_M,
  COMPANION_CAMERA_MIN_PITCH_DEG,
  COMPANION_CAMERA_PRESETS,
  COMPANION_CAMERA_PRESET_IDS,
  DEFAULT_COMPANION_CAMERA,
  companionCameraPose,
  normalizeCompanionCamera,
} from './companion-camera.js';

describe('companion camera defaults + presets', () => {
  it('defaults to the bust framing that mirrors the long-standing stage', () => {
    expect(DEFAULT_COMPANION_CAMERA.preset).toBe('bust');
    expect(DEFAULT_COMPANION_CAMERA).toEqual({
      preset: 'bust',
      ...COMPANION_CAMERA_PRESETS.bust,
    });
  });

  it('exposes the four preset ids in a fixed order', () => {
    expect(COMPANION_CAMERA_PRESET_IDS).toEqual(['face', 'bust', 'full-body', 'custom']);
  });

  it('orders the geometric presets from closest to furthest', () => {
    expect(COMPANION_CAMERA_PRESETS.face.distanceM).toBeLessThan(
      COMPANION_CAMERA_PRESETS.bust.distanceM,
    );
    expect(COMPANION_CAMERA_PRESETS.bust.distanceM).toBeLessThan(
      COMPANION_CAMERA_PRESETS['full-body'].distanceM,
    );
  });
});

describe('normalizeCompanionCamera', () => {
  it('falls back to the default for junk input', () => {
    expect(normalizeCompanionCamera(null)).toEqual({ ...DEFAULT_COMPANION_CAMERA });
    expect(normalizeCompanionCamera('nope')).toEqual({ ...DEFAULT_COMPANION_CAMERA });
    expect(normalizeCompanionCamera({})).toEqual({ ...DEFAULT_COMPANION_CAMERA });
  });

  it('rejects an unknown preset name and keeps the default', () => {
    const out = normalizeCompanionCamera({ preset: 'extreme-closeup' });
    expect(out.preset).toBe('bust');
  });

  it('clamps distance, fov and pitch into their bounds', () => {
    const out = normalizeCompanionCamera({
      preset: 'custom',
      distanceM: 999,
      heightM: -5,
      pitchDeg: 999,
      fovDeg: 999,
    });
    expect(out.distanceM).toBe(COMPANION_CAMERA_MAX_M);
    expect(out.heightM).toBeGreaterThanOrEqual(0);
    expect(out.pitchDeg).toBe(COMPANION_CAMERA_MAX_PITCH_DEG);
    expect(out.fovDeg).toBe(COMPANION_CAMERA_MAX_FOV_DEG);

    const low = normalizeCompanionCamera({
      preset: 'custom',
      distanceM: -50,
      pitchDeg: -999,
      fovDeg: -999,
    });
    expect(low.distanceM).toBe(COMPANION_CAMERA_MIN_M);
    expect(low.pitchDeg).toBe(COMPANION_CAMERA_MIN_PITCH_DEG);
    expect(low.fovDeg).toBe(COMPANION_CAMERA_MIN_FOV_DEG);
  });

  it('round-trips a valid custom camera unchanged', () => {
    const custom = { preset: 'custom' as const, distanceM: 2.5, heightM: 1.6, pitchDeg: 5, fovDeg: 40 };
    expect(normalizeCompanionCamera(custom)).toEqual(custom);
  });

  it('coerces numeric strings (a hand-edited settings file)', () => {
    const out = normalizeCompanionCamera({ preset: 'custom', distanceM: '2.5', fovDeg: '40' });
    expect(out.distanceM).toBe(2.5);
    expect(out.fovDeg).toBe(40);
  });
});

describe('companionCameraPose', () => {
  it('maps a preset to a pose with a radian pitch and the preset fov', () => {
    const pose = companionCameraPose({ preset: 'face', ...COMPANION_CAMERA_PRESETS.face });
    expect(pose.distanceM).toBe(COMPANION_CAMERA_PRESETS.face.distanceM);
    expect(pose.heightM).toBe(COMPANION_CAMERA_PRESETS.face.heightM);
    expect(pose.fovDeg).toBe(COMPANION_CAMERA_PRESETS.face.fovDeg);
    expect(pose.pitchRad).toBeCloseTo((COMPANION_CAMERA_PRESETS.face.pitchDeg * Math.PI) / 180, 6);
  });

  it('derives a named preset from the table, ignoring stored numbers', () => {
    const pose = companionCameraPose({
      preset: 'bust',
      distanceM: 999,
      heightM: 999,
      pitchDeg: 999,
      fovDeg: 999,
    });
    expect(pose.distanceM).toBe(COMPANION_CAMERA_PRESETS.bust.distanceM);
    expect(pose.fovDeg).toBe(COMPANION_CAMERA_PRESETS.bust.fovDeg);
  });

  it('converts a negative pitch to a negative radian angle', () => {
    const pose = companionCameraPose({
      preset: 'custom',
      distanceM: 2,
      heightM: 1.5,
      pitchDeg: -12,
      fovDeg: 30,
    });
    expect(pose.pitchRad).toBeLessThan(0);
  });
});
