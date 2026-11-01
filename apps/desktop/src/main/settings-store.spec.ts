import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, DEFAULT_NOTIFICATION_SETTINGS } from './settings-store.js';
import { DEFAULT_COMPANION_CAMERA } from '../shared/companion-camera.js';

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'nexus-settings-')), 'settings.json');
}

describe('createSettingsStore — ui settings', () => {
  it('defaults loginCountry to null and notifications to the safe defaults', () => {
    const store = createSettingsStore(tempFile());
    const ui = store.getUiSettings();
    expect(ui.loginCountry).toBeNull();
    expect(ui.notifications).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it('defaults companion placement to bottom-right without stealing focus', () => {
    const ui = createSettingsStore(tempFile()).getUiSettings();
    expect(ui.companionPlacement).toEqual({
      mode: 'bottom-right',
      gapPx: 16,
      rememberPerAgent: false,
      bringMainToFront: false,
      windowSize: { preset: 'standard', width: 560, height: 740 },
    });
  });

  it('persists a companion placement choice and repairs a hand-edited one', () => {
    const path = tempFile();
    const store = createSettingsStore(path);
    const next = store.setUiSettings({
      companionPlacement: {
        mode: 'center',
        gapPx: 24,
        rememberPerAgent: true,
        bringMainToFront: true,
        windowSize: { preset: 'compact', width: 999, height: 999 },
      },
    });
    expect(next.companionPlacement.mode).toBe('center');
    expect(createSettingsStore(path).getUiSettings().companionPlacement).toEqual({
      mode: 'center',
      gapPx: 24,
      rememberPerAgent: true,
      bringMainToFront: true,
      // A named preset always resolves to its canonical pixels, never the
      // stale values that were submitted alongside it.
      windowSize: { preset: 'compact', width: 380, height: 480 },
    });
    // A bogus mode falls back to the default rather than reaching the window code.
    writeFileSync(path, JSON.stringify({ ui: { companionPlacement: { mode: 'moon', gapPx: -3 } } }), 'utf8');
    const repaired = createSettingsStore(path).getUiSettings().companionPlacement;
    expect(repaired.mode).toBe('bottom-right');
    expect(repaired.gapPx).toBe(0);
  });

  it('persists a picked login country, upper-cased', () => {
    const path = tempFile();
    const store = createSettingsStore(path);
    expect(store.setUiSettings({ loginCountry: 'de' }).loginCountry).toBe('DE');
    // A fresh store over the same file must see it (survives restarts).
    expect(createSettingsStore(path).getUiSettings().loginCountry).toBe('DE');
  });

  it('rejects a hand-edited invalid country instead of passing it through', () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ ui: { loginCountry: 'deutschland' } }), 'utf8');
    expect(createSettingsStore(path).getUiSettings().loginCountry).toBeNull();
  });

  it('keeps notifications valid when a hand-edited file is malformed', () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ ui: { notifications: { cardMode: 'bogus' } } }), 'utf8');
    expect(createSettingsStore(path).getUiSettings().notifications.cardMode).toBe('full');
  });

  it('applies a partial patch without dropping the other ui fields', () => {
    const store = createSettingsStore(tempFile());
    store.setUiSettings({ locale: 'de', loginCountry: 'FR' });
    const next = store.setUiSettings({ loginCountry: 'DE' });
    expect(next.locale).toBe('de');
    expect(next.loginCountry).toBe('DE');
  });

  it('defaults companion avatar click-nod ON with the `nod` gesture and a widened gaze cone', () => {
    const ui = createSettingsStore(tempFile()).getUiSettings();
    expect(ui.companionAvatar).toEqual({
      clickNod: true,
      clickNodGesture: 'nod',
      gazeYawMaxDeg: 30,
      gazePitchMaxDeg: 22,
      camera: { ...DEFAULT_COMPANION_CAMERA },
    });
  });

  it('persists a disabled companion click-nod, a custom gesture and gaze cone', () => {
    const path = tempFile();
    const store = createSettingsStore(path);
    const next = store.setUiSettings({
      companionAvatar: {
        clickNod: false,
        clickNodGesture: 'agree',
        gazeYawMaxDeg: 45,
        gazePitchMaxDeg: 22,
        camera: { preset: 'face', distanceM: 1.15, heightM: 1.68, pitchDeg: 6, fovDeg: 24 },
      },
    });
    expect(next.companionAvatar).toEqual({
      clickNod: false,
      clickNodGesture: 'agree',
      gazeYawMaxDeg: 45,
      gazePitchMaxDeg: 22,
      camera: { preset: 'face', distanceM: 1.15, heightM: 1.68, pitchDeg: 6, fovDeg: 24 },
    });
    expect(createSettingsStore(path).getUiSettings().companionAvatar).toEqual({
      clickNod: false,
      clickNodGesture: 'agree',
      gazeYawMaxDeg: 45,
      gazePitchMaxDeg: 22,
      camera: { preset: 'face', distanceM: 1.15, heightM: 1.68, pitchDeg: 6, fovDeg: 24 },
    });
  });

  it('repairs a hand-edited companion avatar block (blank gesture, bad types)', () => {
    const path = tempFile();
    writeFileSync(
      path,
      JSON.stringify({
        ui: { companionAvatar: { clickNod: 'yes', clickNodGesture: '  ', gazeYawMaxDeg: 'wide' } },
      }),
      'utf8',
    );
    expect(createSettingsStore(path).getUiSettings().companionAvatar).toEqual({
      clickNod: true,
      clickNodGesture: 'nod',
      gazeYawMaxDeg: 30,
      gazePitchMaxDeg: 22,
      camera: { ...DEFAULT_COMPANION_CAMERA },
    });
  });

  it('clamps out-of-range companion gaze cone degrees into the library bounds', () => {
    const path = tempFile();
    const store = createSettingsStore(path);
    const next = store.setUiSettings({
      companionAvatar: {
        clickNod: true,
        clickNodGesture: 'nod',
        gazeYawMaxDeg: 999,
        gazePitchMaxDeg: -5,
        camera: { ...DEFAULT_COMPANION_CAMERA },
      },
    });
    expect(next.companionAvatar.gazeYawMaxDeg).toBe(60);
    expect(next.companionAvatar.gazePitchMaxDeg).toBe(8);
  });

  it('defaults the app reply voice to off and unset', () => {
    const ui = createSettingsStore(tempFile()).getUiSettings();
    expect(ui.appDefaultTts).toEqual({
      enabled: false,
      modelId: null,
      voiceId: null,
      voiceSampleRef: null,
      voiceSampleTranscript: null,
    });
  });

  it('persists an app reply voice choice', () => {
    const path = tempFile();
    const next = createSettingsStore(path).setUiSettings({
      appDefaultTts: {
        enabled: true,
        modelId: 'fish-s1',
        voiceId: 'ref-42',
        voiceSampleRef: null,
        voiceSampleTranscript: null,
      },
    });
    expect(next.appDefaultTts).toEqual({
      enabled: true,
      modelId: 'fish-s1',
      voiceId: 'ref-42',
      voiceSampleRef: null,
      voiceSampleTranscript: null,
    });
    expect(createSettingsStore(path).getUiSettings().appDefaultTts).toEqual({
      enabled: true,
      modelId: 'fish-s1',
      voiceId: 'ref-42',
      voiceSampleRef: null,
      voiceSampleTranscript: null,
    });
  });

  it('persists an app reply voice clone sample', () => {
    const path = tempFile();
    const next = createSettingsStore(path).setUiSettings({
      appDefaultTts: {
        enabled: true,
        modelId: 'fish-s1',
        voiceId: null,
        voiceSampleRef: { bucketId: 'ws', objectKey: 'a.wav' },
        voiceSampleTranscript: 'words',
      },
    });
    expect(next.appDefaultTts).toEqual({
      enabled: true,
      modelId: 'fish-s1',
      voiceId: null,
      voiceSampleRef: { bucketId: 'ws', objectKey: 'a.wav' },
      voiceSampleTranscript: 'words',
    });
  });

  it('drops an app reply voice with no model, keeping a disabled pick', () => {
    // A voice without a model is meaningless (the voice list belongs to a model).
    expect(
      createSettingsStore(tempFile()).setUiSettings({
        appDefaultTts: {
          enabled: true,
          modelId: null,
          voiceId: 'orphan',
          voiceSampleRef: null,
          voiceSampleTranscript: null,
        },
      }).appDefaultTts,
    ).toEqual({
      enabled: true,
      modelId: null,
      voiceId: null,
      voiceSampleRef: null,
      voiceSampleTranscript: null,
    });
    // A disabled block still keeps model + voice so re-enabling restores them.
    const path = tempFile();
    expect(
      createSettingsStore(path).setUiSettings({
        appDefaultTts: {
          enabled: false,
          modelId: 'm',
          voiceId: 'v',
          voiceSampleRef: null,
          voiceSampleTranscript: null,
        },
      }).appDefaultTts,
    ).toEqual({
      enabled: false,
      modelId: 'm',
      voiceId: 'v',
      voiceSampleRef: null,
      voiceSampleTranscript: null,
    });
  });

  it('repairs a hand-edited app reply voice block', () => {
    const path = tempFile();
    writeFileSync(
      path,
      JSON.stringify({ ui: { appDefaultTts: { enabled: 'yes', modelId: 42, voiceId: '' } } }),
      'utf8',
    );
    expect(createSettingsStore(path).getUiSettings().appDefaultTts).toEqual({
      enabled: false,
      modelId: null,
      voiceId: null,
      voiceSampleRef: null,
      voiceSampleTranscript: null,
    });
  });
});
