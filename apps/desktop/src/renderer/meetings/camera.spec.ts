import { describe, expect, it, vi } from 'vitest';
import { attachCameraStream, detachCameraStream, localVideoEnabled, type CameraSink } from './camera.js';
import type { MediaStreamLike } from '@nexus/meetings-core';

const stream = { getTracks: () => [] } as MediaStreamLike;

describe('attachCameraStream', () => {
  it('sets srcObject, mutes the element, and starts playback', () => {
    const play = vi.fn(() => Promise.resolve());
    const sink: CameraSink = { srcObject: null, play };
    attachCameraStream(stream, sink);
    expect(sink.srcObject).toBe(stream);
    expect(sink.muted).toBe(true);
    expect(sink.playsInline).toBe(true);
    expect(play).toHaveBeenCalled();
  });

  it('swallows a play() rejection (autoplay blocked)', async () => {
    const sink: CameraSink = { srcObject: null, play: () => Promise.reject(new Error('blocked')) };
    expect(() => attachCameraStream(stream, sink)).not.toThrow();
    await Promise.resolve();
    expect(sink.srcObject).toBe(stream);
  });

  it('tolerates an element with no play()', () => {
    const sink: CameraSink = { srcObject: null };
    expect(() => attachCameraStream(stream, sink)).not.toThrow();
  });
});

describe('detachCameraStream', () => {
  it('clears srcObject and tolerates null', () => {
    const sink: CameraSink = { srcObject: stream };
    detachCameraStream(sink);
    expect(sink.srcObject).toBeNull();
    expect(() => detachCameraStream(null)).not.toThrow();
  });
});

describe('localVideoEnabled', () => {
  it('is true when video or screenshare is on', () => {
    expect(localVideoEnabled({ video: true, screensharing: false })).toBe(true);
    expect(localVideoEnabled({ video: false, screensharing: true })).toBe(true);
    expect(localVideoEnabled({ video: false, screensharing: false })).toBe(false);
  });
});
