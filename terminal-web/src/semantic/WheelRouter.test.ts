import { expect, it, vi } from 'vitest';
import { WheelRouter } from './WheelRouter';
import type { SemanticFrame } from './presentation';

it('keeps history and views without control local, and discards residuals on mode changes', () => {
  const router = new WheelRouter();
  const send = vi.fn();
  const route = (generation: number, epoch = 3, browsing = false, delta = -9, bufferKind = 'alternate') => router.route(
    { width: 80, height: 24, bufferKind, wheelGeneration: generation } as SemanticFrame, browsing, epoch,
    { left: 10, top: 4, width: 640, height: 432 } as DOMRect, {clientX: 30, clientY: 49}, delta, 0, 4, send);
  expect(route(0)).toBe('none');
  expect(route(0, 3, false, -9, 'normal')).toBe('history');
  expect(route(1, 0)).toBe('none');
  expect(route(1, 3, true)).toBe('history');
  expect(route(1)).toBe('application');
  route(2);
  expect(send).not.toHaveBeenCalled();
  route(2);
  expect(send).toHaveBeenCalledWith({ generation: 2, controllerEpoch: 3, steps: -1, modifiers: 4, x: 2.5, y: 2.5 });
  route(2, 3, false, 1e6);
  expect(send.mock.lastCall?.[0].steps).toBe(32);
});
