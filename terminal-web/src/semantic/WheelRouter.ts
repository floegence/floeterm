import type { WheelIntent } from '../live/codec.js';
import type { SemanticFrame } from './presentation.js';

export class WheelRouter {
  private residual = 0;
  private owner = '';

  reset(): void { this.owner = ''; this.residual = 0; }

  route(frame: SemanticFrame | undefined, browsing: boolean, epoch: number, rect: DOMRect, point: { clientX: number; clientY: number },
    delta: number, deltaMode: number, modifiers: number, send: (intent: WheelIntent) => void): 'history' | 'application' | 'none' {
    if (!frame || browsing || !frame.wheelGeneration || !epoch) {
      this.reset();
      return browsing || frame?.bufferKind === 'normal' ? 'history' : 'none';
    }
    if (!Number.isFinite(delta) || !delta || !(rect.width > 0 && rect.height > 0)) return 'none';
    const owner = `${epoch}/${frame.wheelGeneration}`;
    if (this.owner !== owner || Math.sign(delta) !== Math.sign(this.residual)) this.residual = 0;
    this.owner = owner;
    this.residual += deltaMode === 1 ? delta : deltaMode === 2 ? delta * frame.height : delta * frame.height / rect.height;
    const whole = Math.trunc(this.residual);
    this.residual -= whole;
    if (whole) send({ generation: frame.wheelGeneration, controllerEpoch: epoch, steps: Math.min(32, Math.max(-32, whole)), modifiers,
      x: Math.min(frame.width - 0.01, Math.max(0, (point.clientX - rect.left) * frame.width / rect.width)),
      y: Math.min(frame.height - 0.01, Math.max(0, (point.clientY - rect.top) * frame.height / rect.height)) });
    return 'application';
  }
}
