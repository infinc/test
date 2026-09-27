export const TAP_MAX_MOVE_PX = 10;
export const LONG_PRESS_MS = 500;
export const SWIPE_MIN_MS = 100;
export const SWIPE_MAX_MS = 2000;
export const LONG_PRESS_MAX_MS = 5000;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round4 = (value) => Math.round(value * 10000) / 10000;

export function normalize(point, rect) {
  return {
    x: round4(clamp((point.x - rect.left) / rect.width, 0, 1)),
    y: round4(clamp((point.y - rect.top) / rect.height, 0, 1)),
  };
}

export function classifyGesture({ start, end, elapsedMs, rect }) {
  const from = normalize(start, rect);
  const moved = Math.hypot(end.x - start.x, end.y - start.y);
  if (moved < TAP_MAX_MOVE_PX) {
    if (elapsedMs >= LONG_PRESS_MS) {
      return { type: 'longpress', ...from, durationMs: clamp(Math.round(elapsedMs), LONG_PRESS_MS, LONG_PRESS_MAX_MS) };
    }
    return { type: 'tap', ...from };
  }
  const to = normalize(end, rect);
  return {
    type: 'swipe',
    x1: from.x,
    y1: from.y,
    x2: to.x,
    y2: to.y,
    durationMs: clamp(Math.round(elapsedMs), SWIPE_MIN_MS, SWIPE_MAX_MS),
  };
}
