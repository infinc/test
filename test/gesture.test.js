import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyGesture } from '../public/assets/gesture.js';

const rect = { left: 100, top: 50, width: 200, height: 400 };

describe('classifyGesture', () => {
  it('treats a short, still press as a tap with normalized coordinates', () => {
    const gesture = classifyGesture({ start: { x: 200, y: 250 }, end: { x: 203, y: 252 }, elapsedMs: 120, rect });
    assert.deepEqual(gesture, { type: 'tap', x: 0.5, y: 0.5 });
  });

  it('treats a still press of 500ms or more as a long press', () => {
    const gesture = classifyGesture({ start: { x: 100, y: 50 }, end: { x: 100, y: 50 }, elapsedMs: 700.4, rect });
    assert.deepEqual(gesture, { type: 'longpress', x: 0, y: 0, durationMs: 700 });
  });

  it('caps long presses at 5 seconds', () => {
    const gesture = classifyGesture({ start: { x: 150, y: 150 }, end: { x: 150, y: 150 }, elapsedMs: 9000, rect });
    assert.equal(gesture.durationMs, 5000);
  });

  it('treats movement as a swipe and clamps duration and out-of-bounds points', () => {
    const gesture = classifyGesture({ start: { x: 200, y: 400 }, end: { x: 500, y: 0 }, elapsedMs: 30, rect });
    assert.deepEqual(gesture, { type: 'swipe', x1: 0.5, y1: 0.875, x2: 1, y2: 0, durationMs: 100 });

    const slow = classifyGesture({ start: { x: 200, y: 400 }, end: { x: 200, y: 100 }, elapsedMs: 9000, rect });
    assert.equal(slow.durationMs, 2000);
  });
});
