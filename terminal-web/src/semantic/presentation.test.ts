import { describe, expect, it, vi } from 'vitest';
import { validatePresentation } from './presentation';
import { RendererSurface } from './RendererSurface';

const valid = () => ({ sequence: 1, geometry: { generation: 1, cols: 2, rows: 1 }, state: { sequence: 1 }, frame: { width: 2, height: 1, bufferKind: 'normal', rows: [{ cells: [{ text: '界', width: 1, style: { foreground: 'rgb:e5e7eb', background: 'indexed:1' } }, { text: '', width: 2 }] }], cursor: { x: 0, y: 0, visible: true } } });
describe('semantic presentation', () => {
  it('requires atomic geometry and frame shape', () => { expect(validatePresentation(valid())).toEqual(valid()); expect(() => validatePresentation({ ...valid(), frame: { ...valid().frame, width: 3 } })).toThrow(/geometry/); });
  it('replaces the complete canvas and paints semantic colors at CSS/DPR geometry', () => {
    const clearRect=vi.fn(), fillRect=vi.fn(), fillText=vi.fn(), setTransform=vi.fn();
    const context={clearRect,fillRect,fillText,setTransform,font:'',textBaseline:'',fillStyle:''};
    const canvasMock={width:0,height:0,clientWidth:180,clientHeight:90,style:{},getBoundingClientRect:()=>({width:180,height:90}),getContext:()=>context};
    const canvas=canvasMock as unknown as HTMLCanvasElement;
    new RendererSurface(canvas).apply(validatePresentation(valid()));
    expect(canvas.width).toBe(180); expect(canvas.height).toBe(90);
    expect(clearRect).toHaveBeenCalledWith(0,0,180,90);
    expect(fillRect).toHaveBeenCalledWith(0,0,90.5,90.5);
    expect(fillText).toHaveBeenCalledWith('界',0,73.8);
    canvasMock.clientHeight = 45;
    new RendererSurface(canvas).apply(validatePresentation(valid()));
  });
});
