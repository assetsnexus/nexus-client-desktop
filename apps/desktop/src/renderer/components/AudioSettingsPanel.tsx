/**
 * Settings → Audio (inputs & outputs).
 *
 * One block for each direction:
 *  - **Output**: pick the primary speaker, then allow-list any *other* speakers an
 *    agent may be sent to (or broadcast on). The allow-list is what gates the
 *    agent's `audio_set_output` / `audio_list_outputs` client tools.
 *  - **Input**: pick the single microphone used for the user's speech-to-text,
 *    then add 0..n extra microphones that *also* listen for wake words so a
 *    phrase spoken near any of them activates the agent.
 *
 * TRUST: this only chooses among devices the OS exposes and the user permits. It
 * never grants new access and never records audio.
 */

import { useMemo, type CSSProperties } from 'react';
import { audioStore, useAudioSnapshot } from '../audio/use-audio-store.js';
import { reconcileWakeDirector } from '../wake/director-host.js';

const section: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 14,
  borderRadius: 12,
  background: '#151b22',
  border: '1px solid #2a333d',
};

const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: '#9aa7b5',
};

const input: CSSProperties = {
  padding: '6px 9px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0f1419',
  color: '#e8eef4',
  fontSize: 13,
};

const chip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 8px',
  borderRadius: 999,
  background: '#1c2430',
  border: '1px solid #3a4654',
  fontSize: 11,
  color: '#cbd5e1',
};

const DEFAULT_SENTINEL = '__default__';

export function AudioSettingsPanel() {
  const snapshot = useAudioSnapshot();
  const { settings, inputs, outputs } = snapshot;

  // Outputs selectable as a secondary speaker: everything but the primary.
  const secondaryOutputs = useMemo(
    () => outputs.filter((device) => device.deviceId !== settings.output.primaryOutputId),
    [outputs, settings.output.primaryOutputId],
  );
  // Inputs selectable as an extra wake mic: everything but the primary.
  const secondaryInputs = useMemo(
    () => inputs.filter((device) => device.deviceId !== settings.input.primaryInputId),
    [inputs, settings.input.primaryInputId],
  );

  const setPrimaryOutput = (value: string) => {
    const id = value === DEFAULT_SENTINEL ? null : value;
    void audioStore().setPatch({
      output: {
        primaryOutputId: id,
        // The primary can never also be a secondary.
        allowedOutputIds: settings.output.allowedOutputIds.filter((x) => x !== id),
      },
    });
  };

  const toggleAllowedOutput = (deviceId: string, allowed: boolean) => {
    const next = allowed
      ? settings.output.allowedOutputIds.filter((x) => x !== deviceId)
      : [...settings.output.allowedOutputIds, deviceId];
    void audioStore().setPatch({ output: { ...settings.output, allowedOutputIds: next } });
  };

  const setPrimaryInput = (value: string) => {
    const id = value === DEFAULT_SENTINEL ? null : value;
    void audioStore().setPatch({
      input: {
        primaryInputId: id,
        wakeInputIds: settings.input.wakeInputIds.filter((x) => x !== id),
      },
    });
    // A different dictation mic must be picked up on the next wake reconcile too.
    void reconcileWakeDirector();
  };

  const toggleWakeInput = (deviceId: string, listed: boolean) => {
    const next = listed
      ? settings.input.wakeInputIds.filter((x) => x !== deviceId)
      : [...settings.input.wakeInputIds, deviceId];
    void audioStore().setPatch({ input: { ...settings.input, wakeInputIds: next } });
    // Arm/disarm the extra listening microphones immediately.
    void reconcileWakeDirector();
  };

  return (
    <section style={section}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Audio</h2>
        <span style={{ flex: 1 }} />
        {!snapshot.hasMicPermission ? (
          <span style={{ fontSize: 11, color: '#fbbf24' }} title="Device names appear once microphone access is granted.">
            device names need microphone permission
          </span>
        ) : null}
      </div>

      {/* Outputs */}
      <div style={{ ...field, gap: 8 }}>
        <strong style={{ fontSize: 12, color: '#e8eef4' }}>Output</strong>
        <label style={field}>
          <span>Primary speaker for agent speech</span>
          <select
            style={input}
            value={settings.output.primaryOutputId ?? DEFAULT_SENTINEL}
            onChange={(e) => setPrimaryOutput(e.target.value)}
          >
            <option value={DEFAULT_SENTINEL}>System default speaker</option>
            {outputs
              .filter((device) => !device.isDefault)
              .map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                  {device.available ? '' : ' (unavailable)'}
                </option>
              ))}
          </select>
        </label>

        <span style={{ color: '#9aa7b5' }}>
          Other speakers the agent is allowed to use (it can switch to one, or
          broadcast to all of them, using its audio tools):
        </span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {secondaryOutputs.length ? (
            secondaryOutputs.map((device) => {
              const allowed = settings.output.allowedOutputIds.includes(device.deviceId);
              return (
                <label key={device.deviceId} style={{ ...chip, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={allowed}
                    onChange={() => toggleAllowedOutput(device.deviceId, allowed)}
                  />
                  {device.label}
                  {device.available ? '' : ' (unavailable)'}
                </label>
              );
            })
          ) : (
            <span style={{ color: '#6b7784' }}>
              No other speakers detected. Connect one to allow the agent to route or broadcast.
            </span>
          )}
        </div>
      </div>

      {/* Inputs */}
      <div style={{ ...field, gap: 8, borderTop: '1px solid #222b34', paddingTop: 12 }}>
        <strong style={{ fontSize: 12, color: '#e8eef4' }}>Input</strong>
        <label style={field}>
          <span>Microphone for your speech (speech-to-text)</span>
          <select
            style={input}
            value={settings.input.primaryInputId ?? DEFAULT_SENTINEL}
            onChange={(e) => setPrimaryInput(e.target.value)}
          >
            <option value={DEFAULT_SENTINEL}>System default microphone</option>
            {inputs
              .filter((device) => !device.isDefault)
              .map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                  {device.available ? '' : ' (unavailable)'}
                </option>
              ))}
          </select>
        </label>

        <span style={{ color: '#9aa7b5' }}>
          Additional microphones that also listen for wake words (a phrase spoken
          near any of them activates the agent):
        </span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {secondaryInputs.length ? (
            secondaryInputs.map((device) => {
              const listed = settings.input.wakeInputIds.includes(device.deviceId);
              return (
                <label key={device.deviceId} style={{ ...chip, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={listed}
                    onChange={() => toggleWakeInput(device.deviceId, listed)}
                  />
                  {device.label}
                  {device.available ? '' : ' (unavailable)'}
                </label>
              );
            })
          ) : (
            <span style={{ color: '#6b7784' }}>
              No other microphones detected.
            </span>
          )}
        </div>
        {settings.input.wakeInputIds.length ? (
          <span style={{ fontSize: 11, color: '#6b7784' }}>
            {settings.input.wakeInputIds.length} extra microphone
            {settings.input.wakeInputIds.length === 1 ? '' : 's'} will listen for wake words in
            addition to the primary one.
          </span>
        ) : null}
      </div>
    </section>
  );
}
