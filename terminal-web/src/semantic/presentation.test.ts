import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assembleHistoryViewport,
  presentationAdvances,
  validateHistoryChunk,
  validateHistoryViewport,
  validatePresentation,
} from './presentation';
import type { SemanticFrame, SemanticPresentation } from './presentation';
import { RendererSurface } from './RendererSurface';
import { getThemeColors } from '../utils/config';

const valid = (): SemanticPresentation => ({ sequence: 1, geometry: { generation: 1, cols: 2, rows: 1 }, state: { sequence: 1 }, frame: { width: 2, height: 1, bufferKind: 'normal', history: { revision: 1, totalRows: 1, screenStartOffset: 0 }, graphics: { generation: 0, images: [], placements: [] }, rows: [{ cells: [{ text: 'A', width: 1, style: { foreground: 'rgb:e5e7eb', background: 'indexed:1' } }, { text: '', width: 1 }] }], cursor: { x: 0, y: 0, visible: true, shape: 'block', blinking: false } } });
describe('semantic presentation', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
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
    expect(() => presentationAdvances(
      { ...current, state: { sequence: 8, contentEpoch: 2 } },
      { ...next(9, 5), state: { sequence: 9, contentEpoch: 1 } },
    )).toThrow(/content epoch regressed/);
  });
  it('requires atomic geometry and frame shape', () => { expect(validatePresentation(valid())).toEqual(valid()); expect(() => validatePresentation({ ...valid(), frame: { ...valid().frame, width: 3 } })).toThrow(/geometry/); });
  it('validates a monotonic semantic content epoch', () => {
    expect(validatePresentation({ ...valid(), state: { sequence: 1, contentEpoch: 0 } }).state.contentEpoch).toBe(0);
    expect(() => validatePresentation({ ...valid(), state: { sequence: 1, contentEpoch: -1 } })).toThrow(/content epoch/);
  });
  it('accepts only the terminal 256-color indexed range', () => {
    const highest = structuredClone(valid());
    highest.frame.rows[0]!.cells[0]!.style!.foreground = 'indexed:255';
    expect(validatePresentation(highest)).toEqual(highest);
    const outside = structuredClone(highest);
    outside.frame.rows[0]!.cells[0]!.style!.foreground = 'indexed:256';
    expect(() => validatePresentation(outside)).toThrow(/semantic color/);
  });
  it('requires a bounded cursor contract and paints each supported visible shape', () => {
    const context = { clearRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), setTransform: vi.fn(), font: '', textBaseline: '', fillStyle: '' };
    const host = { clientWidth: 180, clientHeight: 90 };
    const canvas = { width: 0, height: 0, clientWidth: 180, clientHeight: 90, parentElement: host, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
    const renderer = new RendererSurface(canvas);
    for (const [index, [shape, expected]] of ([
      ['block', [9, 0, 9, 18]],
      ['bar', [9, 0, 2, 18]],
      ['underline', [9, 16, 9, 2]],
    ] as const).entries()) {
      const presentation = structuredClone(valid());
      presentation.frame.cursor = { x: 1, y: 0, visible: true, shape, blinking: true };
      presentation.sequence += index + 1;
      presentation.state.sequence = presentation.sequence;
      presentation.frame.history.revision = presentation.sequence;
      renderer.apply(validatePresentation(presentation));
      expect(context.fillRect).toHaveBeenLastCalledWith(...expected);
    }
    const hidden = structuredClone(valid());
    hidden.frame.cursor = { x: 1, y: 0, visible: false, shape: 'block', blinking: false };
    hidden.sequence = 10;
    hidden.state.sequence = 10;
    hidden.frame.history.revision = 10;
    expect(validatePresentation(hidden).frame.cursor.visible).toBe(false);
    expect(() => validatePresentation({ ...hidden, frame: { ...hidden.frame, cursor: { ...hidden.frame.cursor, shape: 'invalid' } } })).toThrow(/cursor/);
  });
  it('blinks from the current immutable Presentation with one disposable view timer', () => {
    vi.useFakeTimers();
    const context = { clearRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), setTransform: vi.fn(), font: '', textBaseline: '', fillStyle: '' };
    const host = { clientWidth: 180, clientHeight: 90 };
    const canvas = { width: 0, height: 0, clientWidth: 180, clientHeight: 90, parentElement: host, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
    const renderer = new RendererSurface(canvas);
    const presentation = structuredClone(valid());
    presentation.frame.cursor.blinking = true;
    renderer.apply(validatePresentation(presentation));
    expect(context.fillRect).toHaveBeenLastCalledWith(0, 0, 9, 18);
    expect(vi.getTimerCount()).toBe(1);

    context.clearRect.mockClear();
    context.fillRect.mockClear();
    vi.advanceTimersByTime(600);
    expect(context.clearRect).not.toHaveBeenCalled();
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 9.5, 18.5);
    expect(vi.getTimerCount()).toBe(1);

    context.clearRect.mockClear();
    context.fillRect.mockClear();
    vi.advanceTimersByTime(600);
    expect(context.clearRect).not.toHaveBeenCalled();
    expect(context.fillRect).toHaveBeenLastCalledWith(0, 0, 9, 18);
    renderer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels cursor work when the renderer fails closed', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const context = {
      clearRect: vi.fn(), fillRect: vi.fn(() => { throw new Error('paint failed'); }),
      fillText: vi.fn(), setTransform: vi.fn(), font: '', textBaseline: '', fillStyle: '',
    };
    const host = { clientWidth: 180, clientHeight: 90 };
    const canvas = { width: 0, height: 0, clientWidth: 180, clientHeight: 90, parentElement: host, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
    const presentation = structuredClone(valid());
    presentation.frame.cursor.blinking = true;
    const renderer = new RendererSurface(canvas, onError);

    renderer.apply(validatePresentation(presentation));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'paint failed' }));
    expect(vi.getTimerCount()).toBe(0);
    renderer.dispose();
  });
  it('validates and atomically assembles a compact semantic history snapshot', async () => {
    const payload = new TextEncoder().encode(JSON.stringify({
      v: 1,
      frame: {
        ...valid().frame,
        history: { revision: 4, totalRows: 10, screenStartOffset: 9 },
        styles: [['rgb:e5e7eb', 'indexed:1', false, false, false], ['default', 'default', false, false, false]],
        styleInverses: [false, false],
        rows: [[['A', 1, 0, ''], ['', 1, 1, '']]],
      },
    }));
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', payload))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const chunk = validateHistoryChunk({
      snapshotId: 'snapshot', chunkIndex: 0, chunkCount: 1,
      payloadBytes: payload.byteLength, payloadSha256: digest, payload,
      revision: 4, transportGeneration: 2, contentEpoch: 0, geometryGeneration: 1,
      cols: 2, rows: 1,
      anchor: 'page', firstAvailable: 'first', lastAvailable: 'last', screenStart: 'screen',
      offset: 3, totalRows: 10, screenStartOffset: 9, hasPrevious: true, hasNext: true,
    });
    const viewport = await assembleHistoryViewport([chunk]);
    expect(viewport.frame.rows[0]!.cells[0]!.text).toBe('A');
    expect(viewport.frame.height).toBe(1);
    expect(() => validateHistoryChunk({ ...chunk, anchor: '' })).toThrow(/anchor/);
    expect(() => validateHistoryChunk({ ...chunk, payload: new Uint8Array(60 * 1024 + 1) })).toThrow(/payload/);
    expect(() => validateHistoryChunk({ ...chunk, payload: 'A'.repeat(Math.ceil((60 * 1024) / 3) * 4 + 1) })).toThrow(/payload/);
  });
  it('rejects a complete snapshot whose frame is shorter than its canonical viewport', () => {
    const viewport = {
      snapshotId: 'snapshot', lane: 'viewport', revision: 4, transportGeneration: 2, contentEpoch: 0,
      geometryGeneration: 1, cols: 2, rows: 2,
      anchor: 'page', firstAvailable: 'first', lastAvailable: 'last', screenStart: 'screen',
      offset: 3, totalRows: 10, screenStartOffset: 8, hasPrevious: true, hasNext: true,
      frame: { ...valid().frame, history: { revision: 4, totalRows: 10, screenStartOffset: 8 } },
    };
    expect(() => validateHistoryViewport(viewport)).toThrow(/viewport geometry/i);
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

    const firstRenderer = new RendererSurface(canvas);
    firstRenderer.apply(validatePresentation(presentation));

    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalledWith(bitmap, 9, 0, 9, 18));
    expect(canvas.getContext).toHaveBeenCalledTimes(1);
    expect(Array.from(imageData.data)).toEqual([1, 2, 3, 255]);
    expect(Math.max(...context.fillRect.mock.invocationCallOrder)).toBeGreaterThan(context.drawImage.mock.invocationCallOrder[0]);

    host.clientWidth = 240;
    firstRenderer.dispose();
    const renderer = new RendererSurface(canvas);
    renderer.apply(validatePresentation(presentation));
    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(2));
    renderer.resize();
    expect(context.drawImage).toHaveBeenCalledTimes(3);
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    renderer.dispose();
    expect(bitmap.close).toHaveBeenCalledTimes(2);
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
    expect(clearRect).not.toHaveBeenCalled();
    expect(fillRect).toHaveBeenNthCalledWith(1,0,0,180,90);
    expect(fillRect).toHaveBeenCalledWith(0,0,9.5,18.5);
    expect(fillText).toHaveBeenCalledWith('A',0,14.76);
    canvasMock.clientHeight = 45;
    new RendererSurface(canvas).apply(validatePresentation(valid()));
  });

  it('repaints the latest immutable presentation for every view-local palette change', () => {
    let animationFrame: FrameRequestCallback | undefined;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      animationFrame = callback;
      return requestAnimationFrame.mock.calls.length;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    const fills: Array<{ color: string; rect: number[] }> = [];
    const texts: Array<{ color: string; text: string }> = [];
    const context = {
      clearRect: vi.fn(),
      fillRect: vi.fn((...rect: number[]) => fills.push({ color: context.fillStyle, rect })),
      fillText: vi.fn((text: string) => texts.push({ color: context.fillStyle, text })),
      setTransform: vi.fn(),
      font: '', textBaseline: '', fillStyle: '',
    };
    const host = { clientWidth: 180, clientHeight: 90 };
    const canvas = {
      width: 0, height: 0, clientWidth: 180, clientHeight: 90,
      parentElement: host, style: {}, getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const presentation = structuredClone(valid());
    presentation.geometry.cols = 4;
    presentation.frame.width = 4;
    presentation.frame.rows[0]!.cells = [
      { text: 'D', width: 1, style: { foreground: 'default', background: 'default' } },
      { text: 'R', width: 1, style: { foreground: 'rgb:112233', background: 'indexed:196' } },
      { text: 'I', width: 1, style: { foreground: 'indexed:1', background: 'default' } },
      { text: 'V', width: 1, style: { foreground: 'default', background: 'default', inverse: true } },
    ];
    presentation.frame.cursor = { x: 0, y: 0, visible: true, shape: 'bar', blinking: false };
    const renderer = new RendererSurface(canvas);

    renderer.setPalette(getThemeColors('light'));
    renderer.apply(validatePresentation(presentation));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    animationFrame?.(16);
    expect(fills).toContainEqual({ color: '#ffffff', rect: [0, 0, 180, 90] });
    expect(fills).toContainEqual({ color: '#ff0000', rect: [9, 0, 9.5, 18.5] });
    expect(fills).toContainEqual({ color: '#333333', rect: [27, 0, 9.5, 18.5] });
    expect(texts).toContainEqual({ color: '#333333', text: 'D' });
    expect(texts).toContainEqual({ color: '#112233', text: 'R' });
    expect(texts).toContainEqual({ color: '#cd3131', text: 'I' });
    expect(texts).toContainEqual({ color: '#ffffff', text: 'V' });
    expect(canvas.style.background).toBe('#ffffff');

    fills.length = 0;
    texts.length = 0;
    renderer.setPalette(getThemeColors('dark'));
    renderer.setPalette(getThemeColors('dark'));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    animationFrame?.(32);
    expect(fills).toContainEqual({ color: '#0b0f14', rect: [0, 0, 180, 90] });
    expect(fills).toContainEqual({ color: '#ff0000', rect: [9, 0, 9.5, 18.5] });
    expect(fills).toContainEqual({ color: '#c9d1d9', rect: [27, 0, 9.5, 18.5] });
    expect(texts).toContainEqual({ color: '#c9d1d9', text: 'D' });
    expect(texts).toContainEqual({ color: '#112233', text: 'R' });
    expect(texts).toContainEqual({ color: '#ff5c57', text: 'I' });
    expect(texts).toContainEqual({ color: '#0b0f14', text: 'V' });
    expect(presentation.sequence).toBe(1);
    expect(presentation.geometry).toEqual({ generation: 1, cols: 4, rows: 1 });

    fills.length = 0;
    renderer.setPalette(getThemeColors('light'));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(3);
    animationFrame?.(48);
    expect(fills).toContainEqual({ color: '#ffffff', rect: [0, 0, 180, 90] });
    expect(canvas.style.background).toBe('#ffffff');
  });

  it('keeps palettes independent for two views of the same presentation', () => {
    const createSurface = () => {
      const context = { clearRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), setTransform: vi.fn(), font: '', textBaseline: '', fillStyle: '' };
      const host = { clientWidth: 180, clientHeight: 90 };
      const canvas = { width: 0, height: 0, clientWidth: 180, clientHeight: 90, parentElement: host, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
      return { canvas, renderer: new RendererSurface(canvas) };
    };
    const light = createSurface();
    const dark = createSurface();
    const presentation = validatePresentation(valid());

    light.renderer.setPalette(getThemeColors('light'));
    dark.renderer.setPalette(getThemeColors('dark'));
    light.renderer.apply(presentation);
    dark.renderer.apply(presentation);

    expect(light.canvas.style.background).toBe('#ffffff');
    expect(dark.canvas.style.background).toBe('#0b0f14');
    expect(presentation.sequence).toBe(1);
  });

  it('uses each palette cursor and cursor accent for every semantic cursor shape', () => {
    const paints: Array<{ color: string; rect: number[] }> = [];
    const texts: Array<{ color: string; text: string }> = [];
    const context = {
      clearRect: vi.fn(),
      fillRect: vi.fn((...rect: number[]) => paints.push({ color: context.fillStyle, rect })),
      fillText: vi.fn((text: string) => texts.push({ color: context.fillStyle, text })),
      setTransform: vi.fn(), font: '', textBaseline: '', fillStyle: '',
    };
    const host = { clientWidth: 180, clientHeight: 90 };
    const canvas = { width: 0, height: 0, clientWidth: 180, clientHeight: 90, parentElement: host, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
    const renderer = new RendererSurface(canvas);
    let sequence = 1;

    for (const [theme, expectedCursor, expectedAccent] of [
      ['light', '#333333', '#ffffff'],
      ['dark', '#c9d1d9', '#0b0f14'],
    ] as const) {
      renderer.setPalette(getThemeColors(theme));
      for (const shape of ['block', 'bar', 'underline', 'hollow'] as const) {
        paints.length = 0;
        texts.length = 0;
        const presentation = structuredClone(valid());
        presentation.sequence = sequence;
        presentation.state.sequence = sequence;
        presentation.frame.history.revision = sequence;
        presentation.frame.cursor = { x: 0, y: 0, visible: true, shape, blinking: false };
        renderer.apply(validatePresentation(presentation));
        expect(paints.some(paint => paint.color === expectedCursor)).toBe(true);
        if (shape === 'block') expect(texts).toContainEqual({ color: expectedAccent, text: 'A' });
        sequence += 1;
      }
    }
  });

  it('invalidates an in-flight graphics paint as soon as its view palette changes', async () => {
    let animationFrame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrame = callback;
      return 9;
    }));
    const bitmapResolvers: Array<(bitmap: ImageBitmap) => void> = [];
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise<ImageBitmap>(resolve => bitmapResolvers.push(resolve))));
    const context = {
      clearRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), setTransform: vi.fn(),
      createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
      drawImage: vi.fn(), font: '', textBaseline: '', fillStyle: '',
    };
    const host = { clientWidth: 180, clientHeight: 90 };
    const canvas = { width: 0, height: 0, clientWidth: 180, clientHeight: 90, parentElement: host, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
    const presentation = structuredClone(valid());
    presentation.frame.graphics = {
      generation: 1,
      images: [{ id: 7, width: 1, height: 1, format: 0, generation: 1, pixels: new Uint8Array([255, 0, 0]) }],
      placements: [{ imageId: 7, placementId: 1, z: 0, viewportColumn: 0, viewportRow: 0, gridColumns: 1, gridRows: 1, visible: true, virtual: false }],
    };
    const renderer = new RendererSurface(canvas);
    renderer.apply(validatePresentation(presentation));
    animationFrame?.(16);
    expect(bitmapResolvers).toHaveLength(1);
    const staleBitmap = { close: vi.fn() } as unknown as ImageBitmap;

    renderer.setPalette(getThemeColors('light'));
    bitmapResolvers.shift()!(staleBitmap);
    await vi.waitFor(() => expect(staleBitmap.close).toHaveBeenCalledTimes(1));
    expect(context.drawImage).not.toHaveBeenCalled();

    animationFrame?.(32);
    expect(bitmapResolvers).toHaveLength(1);
    const currentBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    bitmapResolvers.shift()!(currentBitmap);
    await vi.waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(1));
    renderer.dispose();
    expect(currentBitmap.close).toHaveBeenCalledTimes(1);
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

  it('keeps the complete old backing until a coalesced resize paint commits', () => {
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
    context.fillRect.mockClear();
    context.fillText.mockClear();
    host.clientWidth = 640;
    host.clientHeight = 300;

    renderer.resize();

    expect(canvasMock.width).toBe(320);
    expect(canvasMock.height).toBe(160);
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(context.fillText).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    animationFrame?.(32);
    expect(canvasMock.width).toBe(640);
    expect(canvasMock.height).toBe(300);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 640, 300);
    expect(context.fillText).toHaveBeenCalledWith('A', 0, 14.76);
  });

  it('atomically repaints every DPR backing resize without recreating the context', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    let animationFrame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrame = callback;
      return 73;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const context={clearRect:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),setTransform:vi.fn(),font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:240,clientHeight:120};
    const getContext=vi.fn(() => context);
    const canvasMock={width:0,height:0,clientWidth:240,clientHeight:120,parentElement:host,style:{},getContext};
    const renderer = new RendererSurface(canvasMock as unknown as HTMLCanvasElement);
    renderer.apply(validatePresentation(valid()));
    animationFrame?.(16);
    context.fillRect.mockClear();
    context.fillText.mockClear();
    host.clientWidth = 360;
    host.clientHeight = 180;

    renderer.resize();

    expect(canvasMock.width).toBe(480);
    expect(canvasMock.height).toBe(240);
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(context.fillText).not.toHaveBeenCalled();

    animationFrame?.(32);
    expect(canvasMock.width).toBe(720);
    expect(canvasMock.height).toBe(360);
    expect(context.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
    expect(context.fillRect).toHaveBeenNthCalledWith(1, 0, 0, 720, 360);
    expect(context.fillText).toHaveBeenCalledWith('A', 0, 14.76);
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it('tracks DPR-only changes when the CSS viewport does not resize', () => {
    let dpr = 1;
    vi.stubGlobal('devicePixelRatio', dpr);
    const listeners: Array<Set<() => void>> = [];
    const queries: string[] = [];
    vi.stubGlobal('matchMedia', vi.fn((query: string) => {
      queries.push(query);
      const ownListeners = new Set<() => void>();
      listeners.push(ownListeners);
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => ownListeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => ownListeners.delete(listener),
        addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
      } as unknown as MediaQueryList;
    }));
    const context = { clearRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), setTransform: vi.fn(), font: '', textBaseline: '', fillStyle: '' };
    const host = { clientWidth: 180, clientHeight: 90 };
    const canvas = { width: 0, height: 0, clientWidth: 180, clientHeight: 90, parentElement: host, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
    const renderer = new RendererSurface(canvas);
    renderer.apply(validatePresentation(valid()));
    expect(canvas.width).toBe(180);
    expect(canvas.height).toBe(90);
    expect(queries).toEqual(['(resolution: 1dppx)']);

    dpr = 1.5;
    vi.stubGlobal('devicePixelRatio', dpr);
    for (const listener of [...listeners[0]!]) listener();

    expect(canvas.width).toBe(270);
    expect(canvas.height).toBe(135);
    expect(context.setTransform).toHaveBeenLastCalledWith(1.5, 0, 0, 1.5, 0, 0);
    expect(queries).toEqual(['(resolution: 1dppx)', '(resolution: 1.5dppx)']);
    expect(listeners[0]).toHaveLength(0);
    expect(listeners[1]).toHaveLength(1);

    renderer.dispose();
    expect(listeners[1]).toHaveLength(0);
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
        cursor: { ...valid().frame.cursor, visible: false },
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

  it('rejects a transport-bounded history frame shorter than the live grid', () => {
    const fillText = vi.fn();
    const fillRect = vi.fn();
    const context={clearRect:vi.fn(),fillRect,fillText,setTransform:vi.fn(),font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:180,clientHeight:90};
    const canvas={width:0,height:0,clientWidth:180,clientHeight:90,parentElement:host,style:{},getContext:()=>context} as unknown as HTMLCanvasElement;
    const renderer = new RendererSurface(canvas);
    const live = structuredClone(valid());
    live.geometry.rows = 2;
    live.frame.height = 2;
    live.frame.rows.push(structuredClone(live.frame.rows[0]!));
    live.frame.history = { revision: 1, totalRows: 2, screenStartOffset: 0 };
    renderer.apply(validatePresentation(live));

    const history = structuredClone(valid().frame);
    history.rows[0]!.cells[0]!.text = 'H';
    expect(() => renderer.project(history)).toThrow(/geometry/i);
    expect(fillRect).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
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
    renderer.updateSelection(12, 10);
    renderer.endSelection(12, 10);

    expect(renderer.hasSelection()).toBe(true);
    expect(renderer.getSelectionText()).toBe('AB');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 9.5, 18.5);
  });

  it('does not turn a click into a selection but keeps an intentional single-cell drag', () => {
    const context={clearRect:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),setTransform:vi.fn(),font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:180,clientHeight:90};
    const canvas={
      width:0,height:0,clientWidth:180,clientHeight:90,parentElement:host,style:{},
      getBoundingClientRect:()=>({ left: 0, top: 0, width: 180, height: 90 }),
      getContext:()=>context,
    } as unknown as HTMLCanvasElement;
    const renderer = new RendererSurface(canvas);
    const value = structuredClone(valid());
    value.frame.rows[0]!.cells[1]!.text = 'B';
    renderer.apply(validatePresentation(value));

    renderer.beginSelection(2, 9);
    renderer.endSelection(2, 9);
    expect(renderer.hasSelection()).toBe(false);
    expect(renderer.getSelectionText()).toBe('');

    renderer.beginSelection(2, 9);
    renderer.updateSelection(7, 12);
    renderer.endSelection(7, 12);
    expect(renderer.hasSelection()).toBe(true);
    expect(renderer.getSelectionText()).toBe('A');
  });

  it('selects semantic words on double click and the logical row on triple click', () => {
    const context={clearRect:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),setTransform:vi.fn(),font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:225,clientHeight:36};
    const canvas={
      width:0,height:0,clientWidth:225,clientHeight:36,parentElement:host,style:{},
      getBoundingClientRect:()=>({ left: 0, top: 0, width: 225, height: 36 }),
      getContext:()=>context,
    } as unknown as HTMLCanvasElement;
    const renderer = new RendererSurface(canvas);
    const cells = [
      ...'foo_2'.split('').map(text => ({ text, width: 1 })),
      { text: ' ', width: 1 },
      ...'/tmp/x'.split('').map(text => ({ text, width: 1 })),
      { text: ' ', width: 1 },
      ...'!!'.split('').map(text => ({ text, width: 1 })),
      { text: ' ', width: 1 },
      { text: '中', width: 2 }, { text: '', width: 0 },
      { text: '文', width: 2 }, { text: '', width: 0 },
      { text: ' ', width: 1 },
      { text: 'e\u0301', width: 1 },
      { text: ' ', width: 1 },
      { text: '👩‍💻', width: 2 }, { text: '', width: 0 },
    ];
    const value = validatePresentation({
      sequence: 1,
      geometry: { generation: 1, cols: 25, rows: 2 },
      state: { sequence: 1 },
      frame: {
        width: 25,
        height: 2,
        bufferKind: 'normal',
        history: { revision: 1, totalRows: 2, screenStartOffset: 0 },
        graphics: { generation: 0, images: [], placements: [] },
        rows: [
          { cells },
          { cells: Array.from({ length: 25 }, () => ({ text: '', width: 1 })) },
        ],
        cursor: { x: 0, y: 1, visible: true, shape: 'bar', blinking: false },
      },
    });
    renderer.apply(value);
    const select = (column: number, clickCount: number) => {
      renderer.beginSelection(column * 9 + 2, 9, clickCount);
      renderer.endSelection(column * 9 + 2, 9);
      return renderer.getSelectionText();
    };

    expect(select(2, 2)).toBe('foo_2');
    expect(select(8, 2)).toBe('/tmp/x');
    expect(select(13, 2)).toBe('!!');
    expect(select(17, 2)).toBe('中文');
    expect(select(21, 2)).toBe('e\u0301');
    expect(select(24, 2)).toBe('👩‍💻');
    expect(select(8, 3)).toBe('foo_2 /tmp/x !! 中文 e\u0301 👩‍💻');
  });

  it('drops selection and a readonly history projection when content epoch advances', () => {
    const fillText = vi.fn();
    const context={clearRect:vi.fn(),fillRect:vi.fn(),fillText,setTransform:vi.fn(),font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:180,clientHeight:90};
    const canvas={
      width:0,height:0,clientWidth:180,clientHeight:90,parentElement:host,style:{},
      getBoundingClientRect:()=>({ left: 0, top: 0, width: 180, height: 90 }),
      getContext:()=>context,
    } as unknown as HTMLCanvasElement;
    const renderer = new RendererSurface(canvas);
    const initial = structuredClone(valid());
    initial.state.contentEpoch = 0;
    initial.frame.rows[0]!.cells[1]!.text = 'B';
    renderer.apply(validatePresentation(initial));
    renderer.beginSelection(1, 10);
    renderer.endSelection(179, 10);
    const history = structuredClone(initial.frame);
    history.rows[0]!.cells[0]!.text = 'H';
    renderer.project(history);

    const cleared = structuredClone(initial);
    cleared.sequence = 2;
    cleared.state = { sequence: 2, contentEpoch: 1 };
    cleared.frame.history.revision = 2;
    cleared.frame.rows[0]!.cells[0]!.text = '';
    cleared.frame.rows[0]!.cells[1]!.text = '';
    renderer.apply(validatePresentation(cleared));

    expect(renderer.hasSelection()).toBe(false);
    expect(renderer.getSelectionText()).toBe('');
    expect((renderer as unknown as { viewportFrame: SemanticFrame | null }).viewportFrame).toBeNull();
  });

  it('keeps wide graphemes at their natural aspect ratio and never paints their continuation', () => {
    const fillText = vi.fn();
    const scale = vi.fn();
    const context={
      clearRect:vi.fn(),fillRect:vi.fn(),fillText,setTransform:vi.fn(),
      save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),scale,
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
        cursor: { x: 0, y: 0, visible: false, shape: 'block', blinking: false },
      },
    });

    new RendererSurface(canvasMock as unknown as HTMLCanvasElement).apply(presentation);

    expect(fillText).toHaveBeenCalledTimes(4);
    expect(scale).not.toHaveBeenCalled();
    expect(fillText).toHaveBeenNthCalledWith(1, 'A', 0, 14.76);
    expect(fillText).toHaveBeenNthCalledWith(2, '中', 12, 14.76);
    expect(fillText).toHaveBeenNthCalledWith(3, '文', 30, 14.76);
    expect(fillText).toHaveBeenNthCalledWith(4, 'B', 45, 14.76);
    expect(context.rect).toHaveBeenNthCalledWith(1, 9, 0, 18, 18);
    expect(context.rect).toHaveBeenNthCalledWith(2, 27, 0, 18, 18);
    expect(context.font).toContain('PingFang SC');
    expect(Math.max(...context.fillRect.mock.invocationCallOrder))
      .toBeLessThan(Math.min(...fillText.mock.invocationCallOrder));
  });

  it('maps the authoritative cursor to a clamped CSS client rect without DPR scaling', () => {
    const context={clearRect:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),setTransform:vi.fn(),font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:18,clientHeight:18};
    const canvas={
      width:36,height:36,clientWidth:18,clientHeight:18,parentElement:host,style:{},
      getBoundingClientRect:()=>({left:100,top:200,right:118,bottom:218,width:18,height:18}),
      getContext:()=>context,
    } as unknown as HTMLCanvasElement;
    const presentation = structuredClone(valid());
    presentation.frame.cursor = { x: 1, y: 0, visible: true, shape: 'bar', blinking: false };
    const renderer = new RendererSurface(canvas);
    renderer.apply(validatePresentation(presentation));

    expect(renderer.getCursorClientRect()).toEqual({ left: 109, top: 200, width: 9, height: 18 });
  });

  it('uses one view-local typography contract for glyphs, cell metrics, and cursor anchors', () => {
    const context = {
      clearRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), setTransform: vi.fn(),
      measureText: vi.fn(() => ({ width: 9.2 })),
      font: '', textBaseline: '', fillStyle: '',
    };
    const host = { clientWidth: 120, clientHeight: 48 };
    const canvas = {
      width: 0, height: 0, clientWidth: 120, clientHeight: 48, parentElement: host, style: {},
      getBoundingClientRect: () => ({ left: 100, top: 200, right: 220, bottom: 248, width: 120, height: 48 }),
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const value = structuredClone(valid());
    value.frame.cursor = { x: 1, y: 0, visible: true, shape: 'bar', blinking: false };
    const renderer = new RendererSurface(canvas);

    expect(renderer.setTypography({
      fontSizeCssPx: 16,
      fontFamily: '"Test Mono", monospace',
      lineHeightCssPx: 24,
    })).toEqual({ cellWidthCssPx: 10, cellHeightCssPx: 24 });
    renderer.apply(validatePresentation(value));

    expect(renderer.getCellMetrics()).toEqual({ cellWidthCssPx: 10, cellHeightCssPx: 24 });
    expect(context.font).toBe('16px "Test Mono", monospace');
    expect(renderer.getCursorClientRect()).toEqual({ left: 110, top: 200, width: 10, height: 24 });
  });

  it('repaints after web fonts settle and removes the listener on dispose', async () => {
    let readyFonts!: () => void;
    const ready = new Promise<void>(resolve => { readyFonts = resolve; });
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const fontSet = {
      ready,
      addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => listeners.add(listener)),
      removeEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => listeners.delete(listener)),
    } as unknown as FontFaceSet;
    vi.stubGlobal('document', {
      fonts: fontSet,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const context={clearRect:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),setTransform:vi.fn(),font:'',textBaseline:'',fillStyle:''};
    const host={clientWidth:18,clientHeight:18};
    const canvas={width:0,height:0,clientWidth:18,clientHeight:18,parentElement:host,style:{},getContext:()=>context} as unknown as HTMLCanvasElement;
    const renderer = new RendererSurface(canvas);
    renderer.apply(validatePresentation(valid()));
    context.fillText.mockClear();

    readyFonts();
    await ready;
    await Promise.resolve();
    expect(context.fillText).toHaveBeenCalled();
    expect(listeners).toHaveLength(1);
    expect(renderer.getCellMetrics()).toEqual({ cellWidthCssPx: 9, cellHeightCssPx: 18 });

    renderer.dispose();
    expect(listeners).toHaveLength(0);
  });
});
