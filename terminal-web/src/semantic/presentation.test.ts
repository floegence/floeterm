import { afterEach, describe, expect, it, vi } from 'vitest';
import { validatePresentation } from './presentation';
import { RendererSurface } from './RendererSurface';

const valid = () => ({ sequence: 1, geometry: { generation: 1, cols: 2, rows: 1 }, state: { sequence: 1 }, frame: { width: 2, height: 1, bufferKind: 'normal', rows: [{ cells: [{ text: 'A', width: 1, style: { foreground: 'rgb:e5e7eb', background: 'indexed:1' } }, { text: '', width: 1 }] }], cursor: { x: 0, y: 0, visible: true } } });
describe('semantic presentation', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('requires atomic geometry and frame shape', () => { expect(validatePresentation(valid())).toEqual(valid()); expect(() => validatePresentation({ ...valid(), frame: { ...valid().frame, width: 3 } })).toThrow(/geometry/); });
  it('rejects semantic cell widths outside narrow, wide, and continuation values', () => {
    const invalid = structuredClone(valid());
    invalid.frame.rows[0].cells[0].width = 3;
    expect(() => validatePresentation(invalid)).toThrow(/semantic cell/);
  });
  it('replaces the complete canvas and paints semantic colors at CSS/DPR geometry', () => {
    const clearRect=vi.fn(), fillRect=vi.fn(), fillText=vi.fn(), setTransform=vi.fn();
    const context={clearRect,fillRect,fillText,setTransform,font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:180,clientHeight:90};
    const canvasMock={width:0,height:0,clientWidth:180,clientHeight:90,parentElement:host,style:{},getBoundingClientRect:()=>({width:180,height:90}),getContext:()=>context};
    const canvas=canvasMock as unknown as HTMLCanvasElement;
    new RendererSurface(canvas).apply(validatePresentation(valid()));
    expect(canvas.width).toBe(180); expect(canvas.height).toBe(90);
    expect(clearRect).toHaveBeenCalledWith(0,0,180,90);
    expect(fillRect).toHaveBeenCalledWith(0,0,90.5,90.5);
    expect(fillText).toHaveBeenCalledWith('A',0,73.8);
    canvasMock.clientHeight = 45;
    new RendererSurface(canvas).apply(validatePresentation(valid()));
  });

  it('measures the pane instead of stale inline canvas dimensions after a host resize', () => {
    const context={clearRect:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),setTransform:vi.fn(),font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:320,clientHeight:160};
    const canvasMock={width:0,height:0,clientWidth:320,clientHeight:160,parentElement:host,style:{},getBoundingClientRect:()=>({width:180,height:90}),getContext:()=>context};
    const canvas=canvasMock as unknown as HTMLCanvasElement;
    const renderer = new RendererSurface(canvas);
    renderer.apply(validatePresentation(valid()));
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(160);
    host.clientWidth = 640;
    host.clientHeight = 300;
    renderer.resize();
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(300);
    expect(canvas.style.width).toBe('100%');
    expect(canvas.style.height).toBe('100%');
  });

  it('does not reallocate the backing store for duplicate resize notifications', () => {
    const context={clearRect:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),setTransform:vi.fn(),font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:640,clientHeight:320};
    let backingWidth = 0;
    let backingHeight = 0;
    const widthWrites = vi.fn((value: number) => { backingWidth = value; });
    const heightWrites = vi.fn((value: number) => { backingHeight = value; });
    const canvasMock={
      get width() { return backingWidth; }, set width(value: number) { widthWrites(value); },
      get height() { return backingHeight; }, set height(value: number) { heightWrites(value); },
      clientWidth:640,clientHeight:320,parentElement:host,style:{},getContext:()=>context,
    };
    const renderer = new RendererSurface(canvasMock as unknown as HTMLCanvasElement);
    renderer.apply(validatePresentation(valid()));
    renderer.resize();
    renderer.resize();

    expect(widthWrites).toHaveBeenCalledTimes(1);
    expect(heightWrites).toHaveBeenCalledTimes(1);
  });

  it('paints only the latest complete presentation once per browser frame', () => {
    let animationFrame: FrameRequestCallback | undefined;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      animationFrame = callback;
      return 42;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    const fillText = vi.fn();
    const context={clearRect:vi.fn(),fillRect:vi.fn(),fillText,setTransform:vi.fn(),font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:180,clientHeight:90};
    const canvasMock={width:0,height:0,clientWidth:180,clientHeight:90,parentElement:host,style:{},getContext:()=>context};
    const renderer = new RendererSurface(canvasMock as unknown as HTMLCanvasElement);
    const presentation = (sequence: number, text: string) => validatePresentation({
      ...valid(),
      sequence,
      state: { sequence },
      frame: {
        ...valid().frame,
        rows: [{ cells: [{ ...valid().frame.rows[0].cells[0], text }, valid().frame.rows[0].cells[1]] }],
      },
    });

    renderer.apply(presentation(1, 'one'));
    renderer.apply(presentation(2, 'two'));
    renderer.apply(presentation(3, 'three'));

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(fillText).not.toHaveBeenCalled();
    animationFrame?.(16);
    expect(fillText).toHaveBeenCalledTimes(1);
    expect(fillText).toHaveBeenCalledWith('three', 0, 73.8);
  });

  it('stretches a wide grapheme across its two semantic columns without painting its continuation', () => {
    const fillText = vi.fn();
    const translate = vi.fn();
    const scale = vi.fn();
    const context={
      clearRect:vi.fn(),fillRect:vi.fn(),fillText,setTransform:vi.fn(),
      save:vi.fn(),restore:vi.fn(),translate,scale,
      measureText:vi.fn(() => ({ width: 12, actualBoundingBoxLeft: 1, actualBoundingBoxRight: 7 })),
      font:'',textBaseline:'',fillStyle:'',
    };
    const host={clientWidth:60,clientHeight:20};
    const canvasMock={width:0,height:0,clientWidth:60,clientHeight:20,parentElement:host,style:{},getContext:()=>context};
    const presentation = validatePresentation({
      sequence: 1,
      geometry: { generation: 1, cols: 6, rows: 1 },
      state: { sequence: 1 },
      frame: {
        width: 6,
        height: 1,
        bufferKind: 'normal',
        rows: [{ cells: [
          { text: 'A', width: 1 },
          { text: '中', width: 2 },
          { text: '', width: 0 },
          { text: '文', width: 2 },
          { text: '', width: 0 },
          { text: 'B', width: 1 },
        ] }],
        cursor: { x: 0, y: 0, visible: true },
      },
    });

    new RendererSurface(canvasMock as unknown as HTMLCanvasElement).apply(presentation);

    expect(fillText).toHaveBeenCalledTimes(4);
    expect(translate).toHaveBeenNthCalledWith(1, 10.8, 0);
    expect(translate).toHaveBeenNthCalledWith(2, 30.8, 0);
    expect(scale.mock.calls[0][0]).toBeCloseTo(2.3, 5);
    expect(scale.mock.calls[1][0]).toBeCloseTo(2.3, 5);
    expect(fillText).toHaveBeenNthCalledWith(2, '中', 1, 16.4);
    expect(fillText).toHaveBeenNthCalledWith(3, '文', 1, 16.4);
    expect(Math.max(...context.fillRect.mock.invocationCallOrder))
      .toBeLessThan(Math.min(...fillText.mock.invocationCallOrder));
  });
});
