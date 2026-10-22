import { describe, expect, it } from 'vitest';
import { encodeFingerprintEnvelope } from './enroll.js';

/** Decode the same way the main process does, to assert round-trip fidelity. */
function decode(base64: string): number[] {
  const buffer = Buffer.from(base64, 'base64');
  const out: number[] = [];
  for (let i = 0; i < buffer.byteLength; i += 4) out.push(buffer.readFloatLE(i));
  return out;
}

describe('encodeFingerprintEnvelope', () => {
  it('round-trips float32 values as little-endian base64', () => {
    const envelope = new Float32Array([0.5, -0.25, 1, 0]);
    const decoded = decode(encodeFingerprintEnvelope(envelope));
    expect(decoded).toHaveLength(4);
    expect(decoded[0]).toBeCloseTo(0.5);
    expect(decoded[1]).toBeCloseTo(-0.25);
    expect(decoded[2]).toBeCloseTo(1);
    expect(decoded[3]).toBe(0);
  });

  it('handles an empty envelope', () => {
    expect(decode(encodeFingerprintEnvelope(new Float32Array([])))).toEqual([]);
  });

  it('survives a large envelope (chunked btoa)', () => {
    const big = new Float32Array(40_000).fill(0.1);
    expect(decode(encodeFingerprintEnvelope(big))).toHaveLength(40_000);
  });
});
