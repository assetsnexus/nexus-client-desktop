import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalVoiceModel } from '@nexus/local-voice';
import { modelDirName } from '@nexus/local-voice';
import { createWakeHost, primaryModelFile } from './wake-host.js';
import type { WakeSettings } from '../shared/wake.js';
import { DEFAULT_WAKE_BEHAVIOR } from '../shared/wake.js';

function wakeModel(overrides: Partial<LocalVoiceModel> = {}): LocalVoiceModel {
  return {
    id: 'catalog:desktop/wake-hey-jarvis',
    kind: 'wake',
    source: 'region',
    label: 'Hey Jarvis',
    modelRef: 'edge/openwakeword-hey-jarvis',
    downloadUrl: 'https://github.com/x/y.onnx',
    sourceUrl: 'https://github.com/x',
    sizeBytes: null,
    vramGiB: 0,
    runtime: 'onnx',
    files: [
      { name: 'hey_jarvis.onnx', url: 'https://github.com/x/y.onnx', sizeBytes: null, sha256: null },
    ],
    licenseKeys: ['apache-2.0'],
    sha256: null,
    ...overrides,
  };
}

function settings(bindings: WakeSettings['bindings']): WakeSettings {
  return { enabled: true, bindings, ...DEFAULT_WAKE_BEHAVIOR };
}

const binding = {
  id: 'w1',
  phrase: 'Hey Jarvis',
  agentId: 'a1',
  agentName: 'Jarvis',
  modelId: 'catalog:desktop/wake-hey-jarvis',
  sensitivity: 0.5,
  enabled: true,
  sampleRef: null,
  sampleFingerprint: null,
};

function makeHost(opts: { model?: LocalVoiceModel | null; installed?: boolean; bindings?: WakeSettings['bindings'] } = {}) {
  const modelsDir = mkdtempSync(join(tmpdir(), 'wake-host-'));
  const model = opts.model === undefined ? wakeModel() : opts.model;
  if (opts.installed !== false && model) {
    const dir = join(modelsDir, modelDirName(model));
    mkdirSync(dir, { recursive: true });
    for (const f of model.files) writeFileSync(join(dir, f.name), Buffer.from([1, 2, 3, 4]));
  }
  let current = settings(opts.bindings ?? [binding]);
  const writeSettings = vi.fn((next: WakeSettings) => {
    current = next;
  });
  const host = createWakeHost({
    modelsDir,
    findModel: (id) => (model && model.id === id ? model : null),
    readSettings: () => current,
    writeSettings,
  });
  return { host, writeSettings, modelsDir };
}

describe('primaryModelFile', () => {
  it('prefers the .onnx file', () => {
    const model = wakeModel({
      files: [
        { name: 'config.json', url: 'u', sizeBytes: null, sha256: null },
        { name: 'model.onnx', url: 'u', sizeBytes: null, sha256: null },
      ],
    });
    expect(primaryModelFile(model)).toBe('model.onnx');
  });

  it('falls back to the first file', () => {
    const model = wakeModel({ files: [{ name: 'weights.bin', url: 'u', sizeBytes: null, sha256: null }] });
    expect(primaryModelFile(model)).toBe('weights.bin');
  });

  it('returns null for a file-less model', () => {
    expect(primaryModelFile(wakeModel({ files: [] }))).toBeNull();
  });
});

describe('createWakeHost.readArtifact', () => {
  it('reads installed model bytes', () => {
    const { host } = makeHost();
    const artifact = host.readArtifact(binding);
    expect(artifact).not.toBeNull();
    expect(artifact!.bytes.byteLength).toBe(4);
    expect(artifact!.fileName).toBe('hey_jarvis.onnx');
  });

  it('returns null when the model is not installed', () => {
    const { host } = makeHost({ installed: false });
    expect(host.readArtifact(binding)).toBeNull();
  });

  it('returns null when the binding has no model', () => {
    const { host } = makeHost();
    expect(host.readArtifact({ ...binding, modelId: null })).toBeNull();
  });

  it('returns null when the model is unknown to the catalog', () => {
    const { host } = makeHost({ model: null });
    expect(host.readArtifact(binding)).toBeNull();
  });
});

describe('createWakeHost.resolveBinding', () => {
  it('reports the engine kind, artifact and armed state', () => {
    const { host } = makeHost();
    const resolved = host.resolveBinding('w1');
    expect(resolved).not.toBeNull();
    expect(resolved!.engineKind).toBe('builtin');
    expect(resolved!.armed).toBe(true);
    expect(resolved!.artifact).not.toBeNull();
  });

  it('uses custom_sample when a sample ref is present', () => {
    const { host } = makeHost({ bindings: [{ ...binding, sampleRef: 'priv:abc' }] });
    expect(host.resolveBinding('w1')!.engineKind).toBe('custom_sample');
  });

  it('decodes an enrolled sample fingerprint off disk-free settings', () => {
    // Two little-endian float32 samples: 0.5 and -0.25.
    const buf = Buffer.alloc(8);
    buf.writeFloatLE(0.5, 0);
    buf.writeFloatLE(-0.25, 4);
    const { host } = makeHost({
      bindings: [{ ...binding, modelId: null, sampleFingerprint: buf.toString('base64') }],
    });
    const resolved = host.resolveBinding('w1');
    expect(resolved!.engineKind).toBe('custom_sample');
    expect(resolved!.customSampleFingerprint?.frames).toBe(2);
    expect(resolved!.customSampleFingerprint?.envelope[0]).toBeCloseTo(0.5);
    expect(resolved!.customSampleFingerprint?.envelope[1]).toBeCloseTo(-0.25);
    expect(resolved!.armed).toBe(true);
  });

  it('returns null for an unknown binding', () => {
    const { host } = makeHost();
    expect(host.resolveBinding('nope')).toBeNull();
  });
});

describe('createWakeHost.setSettings', () => {
  it('normalizes and persists', () => {
    const { host, writeSettings } = makeHost();
    const next = host.setSettings({ enabled: true, bindings: [{ phrase: 'Ok Nexus', sensitivity: 9 }] });
    expect(writeSettings).toHaveBeenCalledTimes(1);
    expect(next.bindings[0]!.sensitivity).toBe(1);
  });

  it('coerces junk into safe defaults', () => {
    const { host } = makeHost();
    const out = host.setSettings(null);
    expect(out.enabled).toBe(false);
    expect(out.bindings).toEqual([]);
    expect(out.activationMode).toBe('chat');
  });
});
