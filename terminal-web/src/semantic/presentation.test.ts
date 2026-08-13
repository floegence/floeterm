import { afterEach, describe, expect, it, vi } from 'vitest';
import { presentationAdvances, validateHistoryPage, validatePresentation } from './presentation';
import type { SemanticPresentation } from './presentation';
import { RendererSurface } from './RendererSurface';

const valid = (): SemanticPresentation => ({ sequence: 1, geometry: { generation: 1, cols: 2, rows: 1 }, state: { sequence: 1 }, frame: { width: 2, height: 1, bufferKind: 'normal', history: { revision: 1, totalRows: 1, screenStartOffset: 0 }, graphics: { generation: 0, images: [], placements: [] }, rows: [{ cells: [{ text: 'A', width: 1, style: { foreground: 'rgb:e5e7eb', background: 'indexed:1' } }, { text: '', width: 1 }] }], cursor: { x: 0, y: 0, visible: true } } });
describe('semantic presentation', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('rejects duplicate or regressing presentation cuts before they replace latest state', () => {
    const current = validatePresentation({
      ...valid(),
      sequence: 8,
      geometry: { generation: 4, cols: 2, rows: 1 },
      state: { sequence: 8 },
      frame: { ...valid().frame, history: { ...valid().frame.history, revision: 8 } },
    });
    const next = (sequence: number, generation: number) => validatePresentation({
      ...valid(),
      sequence,
      geometry: { generation, cols: 2, rows: 1 },
      state: { sequence },
      frame: { ...valid().frame, history: { ...valid().frame.history, revision: sequence } },
    });

    expect(presentationAdvances(current, next(8, 4))).toBe(false);
    expect(presentationAdvances(current, next(7, 4))).toBe(false);
    expect(() => presentationAdvances(current, next(9, 3))).toThrow(/generation regressed/);
    expect(presentationAdvances(current, next(9, 5))).toBe(true);
  });
  it('requires atomic geometry and frame shape', () => { expect(validatePresentation(valid())).toEqual(valid()); expect(() => validatePresentation({ ...valid(), frame: { ...valid().frame, width: 3 } })).toThrow(/geometry/); });
  it('validates bounded semantic history pages without raw replay fields', () => {
    const page = {
      revision: 4, anchor: 'page', firstAvailable: 'first', lastAvailable: 'last', screenStart: 'screen',
      offset: 3, totalRows: 10, screenStartOffset: 9, hasPrevious: true, hasNext: true,
      frame: { ...valid().frame, history: { revision: 4, totalRows: 10, screenStartOffset: 9 } },
    };
    expect(validateHistoryPage(page)).toEqual(page);
    expect(() => validateHistoryPage({ ...page, anchor: '' })).toThrow(/anchor/);
    expect(() => validateHistoryPage({ ...page, frame: { ...page.frame, width: 3 } })).toThrow(/geometry|row width/);
  });
  it('rejects semantic cell widths outside narrow, wide, and continuation values', () => {
    const invalid = structuredClone(valid());
    invalid.frame.rows[0].cells[0].width = 3;
    expect(() => validatePresentation(invalid)).toThrow(/semantic cell/);
  });
  it('validates bounded graphics inventory and rejects malformed pixels or placements', () => {
    const presentation = structuredClone(valid());
    presentation.frame.graphics = {
      generation: 3,
      images: [{ id: 7, width: 1, height: 1, format: 0, generation: 2, pixels: new Uint8Array([1, 2, 3]) }],
      placements: [{ imageId: 7, placementId: 9, z: 0, viewportColumn: 1, viewportRow: 0, gridColumns: 1, gridRows: 1, visible: true, virtual: false }],
    };
    expect(validatePresentation(presentation)).toEqual(presentation);

    const wrongPixels = structuredClone(presentation);
    wrongPixels.frame.graphics.images[0].pixels = new Uint8Array([1, 2]);
    expect(() => validatePresentation(wrongPixels)).toThrow(/graphic.*pixels/i);
    const wrongFormat = structuredClone(presentation);
    (wrongFormat.frame.graphics.images[0] as { format: number }).format = 2;
    expect(() => validatePresentation(wrongFormat)).toThrow(/graphic.*format/i);
    const missingImage = structuredClone(presentation);
    missingImage.frame.graphics.placements[0].imageId = 99;
    expect(() => validatePresentation(missingImage)).toThrow(/graphic.*placement/i);
    const invalidBounds = structuredClone(presentation);
    invalidBounds.frame.graphics.placements[0].viewportColumn = 3;
    expect(() => validatePresentation(invalidBounds)).toThrow(/graphic.*placement/i);
  });

  it('draws RGB graphics through the same visible 2D canvas', async () => {
    const bitmap = { close: vi.fn() };
    const createImageBitmap = vi.fn(async () => bitmap);
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    const imageData = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
    const context={
      clearRect:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),setTransform:vi.fn(),
      createImageData:vi.fn(() => imageData),drawImage:vi.fn(),
      font:'',textBaseline:'',fillStyle:'',
    };
    const host={clientWidth:200,clientHeight:100};
    const canvas={width:0,height:0,clientWidth:200,clientHeight:100,parentElement:host,style:{},getContext:vi.fn(() => context)} as unknown as HTMLCanvasElement;
    const presentation = structuredClone(valid());
    presentation.frame.graphics = {
      generation: 3,
      images: [{ id: 7, width: 1, height: 1, format: 0, generation: 2, pixels: new Uint8Array([1, 2, 3]) }],
      placements: [{ imageId: 7, placementId: 9, z: 0, viewportColumn: 1, viewportRow: 0, gridColumns: 1, gridRows: 1, visible: true, virtual: false }],
    };

    new RendererSurface(canvas).apply(validatePresentation(presentation));

    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalledWith(bitmap, 9, 0, 9, 18));
    expect(canvas.getContext).toHaveBeenCalledTimes(1);
    expect(Array.from(imageData.data)).toEqual([1, 2, 3, 255]);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
  it('fails closed once when an asynchronous graphic decode fails', async () => {
    const createImageBitmap = vi.fn(async () => { throw new Error('bitmap decode failed'); });
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    const onError = vi.fn();
    const context={
      clearRect:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),setTransform:vi.fn(),
      createImageData:vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),drawImage:vi.fn(),
      font:'',textBaseline:'',fillStyle:'',
    };
    const host={clientWidth:200,clientHeight:100};
    const canvas={width:0,height:0,clientWidth:200,clientHeight:100,parentElement:host,style:{},getContext:vi.fn(() => context)} as unknown as HTMLCanvasElement;
    const presentation = structuredClone(valid());
    presentation.frame.graphics = {
      generation: 3,
      images: [{ id: 7, width: 1, height: 1, format: 0, generation: 2, pixels: new Uint8Array([1, 2, 3]) }],
      placements: [{ imageId: 7, placementId: 9, z: 0, viewportColumn: 1, viewportRow: 0, gridColumns: 1, gridRows: 1, visible: true, virtual: false }],
    };
    const renderer = new RendererSurface(canvas, onError);

    renderer.apply(validatePresentation(presentation));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'bitmap decode failed' })));
    renderer.apply(validatePresentation({ ...presentation, sequence: 2, state: { sequence: 2 }, frame: { ...presentation.frame, history: { ...presentation.frame.history, revision: 2 } } }));
    renderer.resize();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });
  it('replaces the complete canvas and paints semantic colors at CSS/DPR geometry', () => {
    const clearRect=vi.fn(), fillRect=vi.fn(), fillText=vi.fn(), setTransform=vi.fn();
    const context={clearRect,fillRect,fillText,setTransform,font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:180,clientHeight:90};
    const canvasMock={width:0,height:0,clientWidth:180,clientHeight:90,parentElement:host,style:{},getBoundingClientRect:()=>({width:180,height:90}),getContext:()=>context};
    const canvas=canvasMock as unknown as HTMLCanvasElement;
    new RendererSurface(canvas).apply(validatePresentation(valid()));
    expect(canvas.width).toBe(180); expect(canvas.height).toBe(90);
    expect(canvas.style.background).toBe('#0b0f14');
    expect(clearRect).toHaveBeenCalledWith(0,0,180,90);
    expect(fillRect).toHaveBeenCalledWith(0,0,9.5,18.5);
    expect(fillText).toHaveBeenCalledWith('A',0,14.76);
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

  it('updates backing geometry synchronously before a coalesced resize paint', () => {
    let animationFrame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrame = callback;
      return 42;
    }));
    const context={clearRect:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),setTransform:vi.fn(),font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:320,clientHeight:160};
    const canvasMock={width:0,height:0,clientWidth:320,clientHeight:160,parentElement:host,style:{},getContext:()=>context};
    const renderer = new RendererSurface(canvasMock as unknown as HTMLCanvasElement);
    renderer.apply(validatePresentation(valid()));
    animationFrame?.(16);
    host.clientWidth = 640;
    host.clientHeight = 300;

    renderer.resize();

    expect(canvasMock.width).toBe(640);
    expect(canvasMock.height).toBe(300);
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
        history: { ...valid().frame.history, revision: sequence },
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
    expect(fillText).toHaveBeenCalledWith('three', 0, 14.76);
  });

  it('projects a readonly history frame on the same canvas and returns to the latest presentation', () => {
    const fillText = vi.fn();
    const context={clearRect:vi.fn(),fillRect:vi.fn(),fillText,setTransform:vi.fn(),font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:180,clientHeight:90};
    const canvas={width:0,height:0,clientWidth:180,clientHeight:90,parentElement:host,style:{},getContext:()=>context} as unknown as HTMLCanvasElement;
    const renderer = new RendererSurface(canvas);
    renderer.apply(validatePresentation(valid()));
    const history = structuredClone(valid().frame);
    history.rows[0]!.cells[0]!.text = 'H';
    renderer.project(history);
    expect(fillText).toHaveBeenLastCalledWith('H', 0, 14.76);
    renderer.project(null);
    expect(fillText).toHaveBeenLastCalledWith('A', 0, 14.76);
  });

  it('owns view-local semantic selection without another renderer', () => {
    const fillRect = vi.fn();
    const context={clearRect:vi.fn(),fillRect,fillText:vi.fn(),setTransform:vi.fn(),font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:180,clientHeight:90};
    const canvas={
      width:0,height:0,clientWidth:180,clientHeight:90,parentElement:host,style:{},
      getBoundingClientRect:()=>({ left: 0, top: 0, width: 180, height: 90 }),
      getContext:()=>context,
    } as unknown as HTMLCanvasElement;
    const renderer = new RendererSurface(canvas);
    const presentation = structuredClone(valid());
    presentation.frame.rows[0]!.cells[1]!.text = 'B';
    renderer.apply(validatePresentation(presentation));

    renderer.beginSelection(1, 10);
    renderer.updateSelection(179, 10);
    renderer.endSelection(179, 10);

    expect(renderer.hasSelection()).toBe(true);
    expect(renderer.getSelectionText()).toBe('AB');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 9.5, 18.5);
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
        history: { revision: 1, totalRows: 1, screenStartOffset: 0 },
        graphics: { generation: 0, images: [], placements: [] },
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
    expect(translate).toHaveBeenNthCalledWith(1, 9.72, 0);
    expect(translate).toHaveBeenNthCalledWith(2, 27.72, 0);
    expect(scale.mock.calls[0][0]).toBeCloseTo(2.07, 5);
    expect(scale.mock.calls[1][0]).toBeCloseTo(2.07, 5);
    expect(fillText).toHaveBeenNthCalledWith(2, '中', 1, 14.76);
    expect(fillText).toHaveBeenNthCalledWith(3, '文', 1, 14.76);
    expect(Math.max(...context.fillRect.mock.invocationCallOrder))
      .toBeLessThan(Math.min(...fillText.mock.invocationCallOrder));
  });
});
