import type { PointerIntent } from '../live/codec.js';
import type { SemanticFrame } from './presentation.js';

type Target = { frame?: SemanticFrame; epoch: number; grid?: DOMRect | null };

export function bindApplicationPointer(canvas: HTMLCanvasElement, target: () => Target,
  send: (intent: PointerIntent) => void, focus: () => void): () => void {
  let drag: { id: number; last: PointerIntent } | null = null;
  let consumeClick = false;
  const listeners = new AbortController();
  const options = { signal: listeners.signal, capture: true };
  function handle(event: PointerEvent) {
    const { frame, epoch, grid } = target();
    const generation = frame?.wheelGeneration;
    const press = event.type === 'pointerdown';
    if (press) {
      consumeClick = false;
      if (drag || event.pointerType !== 'mouse' || event.button !== 0 || event.shiftKey || !frame?.pointerReporting || !epoch || !generation || !grid) return;
    } else if (!drag || drag.id !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const motion = event.type === 'pointermove';
    if (frame?.pointerReporting && grid && epoch && generation && (!drag || (epoch === drag.last.controllerEpoch && generation === drag.last.generation))) {
      const intent: PointerIntent = { action: press ? 'press' : motion ? 'motion' : 'release', controllerEpoch: epoch, generation,
        x: Math.max(0, Math.min(frame.width - 0.01, (event.clientX - grid.left) / grid.width * frame.width)),
        y: Math.max(0, Math.min(frame.height - 0.01, (event.clientY - grid.top) / grid.height * frame.height)),
        modifiers: +event.shiftKey | +event.ctrlKey << 1 | +event.altKey << 2 | +event.metaKey << 3 };
      if (press) {
        canvas.setPointerCapture(event.pointerId);
        focus();
        consumeClick = true;
      }
      send(intent);
      if (press || motion) { drag = { id: event.pointerId, last: intent }; return; }
    }
    drag = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }
  function cancel() {
    if (!drag) return;
    const { id, last } = drag;
    drag = null;
    const { frame, epoch } = target();
    if (epoch === last.controllerEpoch && frame?.wheelGeneration === last.generation && frame.pointerReporting) send({ ...last, action: 'release' });
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }
  canvas.addEventListener('pointerdown', handle, options);
  canvas.addEventListener('pointermove', handle, options);
  canvas.addEventListener('pointerup', handle, options);
  canvas.addEventListener('pointercancel', cancel, options);
  canvas.addEventListener('lostpointercapture', cancel, options);
  canvas.addEventListener('click', event => {
    if (consumeClick && event.button === 0) { consumeClick = false; event.preventDefault(); event.stopImmediatePropagation(); }
  }, options);
  canvas.ownerDocument.defaultView?.addEventListener('blur', cancel, options);
  return () => { cancel(); listeners.abort(); };
}
