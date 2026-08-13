import { describe, expect, it, vi } from 'vitest';
import { validatePresentation } from './presentation';
import { RendererSurface } from './RendererSurface';

const valid = () => ({ sequence: 1, geometry: { generation: 1, cols: 2, rows: 1 }, state: { sequence: 1 }, frame: { width: 2, height: 1, bufferKind: 'normal', rows: [{ cells: [{ text: '界', width: 1 }, { text: '', width: 2 }] }], cursor: { x: 0, y: 0, visible: true } } });
describe('semantic presentation', () => {
  it('requires atomic geometry and frame shape', () => { expect(validatePresentation(valid())).toEqual(valid()); expect(() => validatePresentation({ ...valid(), frame: { ...valid().frame, width: 3 } })).toThrow(/geometry/); });
  it('replaces the complete canvas from one presentation', () => { const clearRect=vi.fn(),fillText=vi.fn(); const canvas={width:0,height:0,getContext:()=>({clearRect,fillText,font:'',textBaseline:'',fillStyle:''})} as unknown as HTMLCanvasElement; new RendererSurface(canvas).apply(validatePresentation(valid())); expect(canvas.width).toBe(18); expect(clearRect).toHaveBeenCalledWith(0,0,18,18); expect(fillText).toHaveBeenCalledWith('界',0,0); });
});
