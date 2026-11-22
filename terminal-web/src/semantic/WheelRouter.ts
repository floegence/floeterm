import type { WheelIntent } from '../live/codec.js';
import type { SemanticFrame } from './presentation.js';

export class WheelRouter {
  private residual = 0;
  private owner = '';

  reset(): void { this.owner = ''; this.residual = 0; }

  route(frame: SemanticFrame | undefined, browsing: boolean, epoch: number, rect: DOMRect, point: { clientX: number; clientY: number },
    delta: number, deltaMode: number, modifiers: number, send: (intent: WheelIntent) => void,
    scrollHistory?: (rows: number) => void): 'history' | 'application' | 'none' {
    if (!frame) { this.reset(); return 'none'; }
    const application = !browsing && !!frame.wheelGeneration && !!epoch;
    if (!application && !browsing && frame.bufferKind !== 'normal') {
      this.reset();
      return 'none';
    }
    if (!Number.isFinite(delta) || !delta || !(rect.width > 0 && rect.height > 0)) return 'none';
    const owner = `${application}/${epoch}/${frame.wheelGeneration ?? 0}/${frame.width}/${frame.height}/${rect.height}`;
    if (this.owner !== owner) this.residual = 0;
    this.owner = owner;
    const rows = this.residual + (deltaMode === 1 ? delta : deltaMode === 2 ? delta * frame.height : delta / (rect.height / frame.height));
    if (!Number.isFinite(rows)) { this.reset(); return 'none'; }
    const whole = Math.trunc(rows);
    this.residual = rows - whole;
    if (!application) {
      if (whole) scrollHistory?.(whole);
      return 'history';
    }
    const x = Math.min(frame.width - 0.01, Math.max(0, (point.clientX - rect.left) * frame.width / rect.width));
    const y = Math.min(frame.height - 0.01, Math.max(0, (point.clientY - rect.top) * frame.height / rect.height));
    for (let remaining = Math.min(Math.abs(whole), 256); remaining > 0; remaining -= 32) {
      send({ generation: frame.wheelGeneration!, controllerEpoch: epoch, steps: Math.sign(whole) * Math.min(remaining, 32), modifiers, x, y });
    }
    return 'application';
  }
}
