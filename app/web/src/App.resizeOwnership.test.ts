// @ts-expect-error Vitest executes this source-contract test in Node without app Node typings.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import appSource from './App.tsx?raw';
import terminalApiSource from './terminalApi.ts?raw';

const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('reference app resize ownership', () => {
  it('gives semantic mode one canvas and one resize observer without legacy renderer mounting', () => {
    expect(appSource.match(/addEventListener\('resize'/g)).toHaveLength(2);
    expect(appSource.match(/removeEventListener\('resize'/g)).toHaveLength(2);
    expect(appSource).not.toContain("addEventListener('orientationchange'");
    expect(appSource).not.toContain('visualViewport');
    expect(appSource).not.toContain('scheduleResize');
    expect(appSource).toContain('new ResizeObserver');
    expect(appSource).toContain('createSemanticResizeController');
    expect(appSource).toContain('class="semanticTerminalSurface"');
    expect(appSource).toContain('const attached = await props.transport.attachWithPresentation(');
    expect(appSource).not.toContain('attachWithPresentation(props.sessionId, 199, 48)');
    expect(appSource).not.toContain('<div class="terminalSurface" ref={terminal.mount} />\n\t\t  <canvas class="semanticTerminalSurface"');
    expect(appSource).not.toContain('createSolidTerminal');
    expect(appSource).not.toContain("rendererType: 'webgl'");
    expect(appSource).not.toContain('getTerminalFabricDiagnostics');
    expect(appSource).not.toContain('ref={terminal.mount}');
    expect(appSource.match(/<canvas[^>]+class="semanticTerminalSurface"/g)).toHaveLength(1);
  });

  it('sizes the only canvas from its host without legacy canvas selectors', () => {
    expect(stylesSource).toMatch(/\.semanticTerminalSurface\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%/);
    expect(stylesSource).not.toContain('canvas:not(.semanticTerminalSurface)');
    expect(appSource).not.toContain('SchedulerStatsPanel');
  });

  it('uses the semantic live control plane without raw replay or checkpoint fallback', () => {
    expect(terminalApiSource).toContain('createSemanticTerminalLiveTransport');
    expect(terminalApiSource).not.toContain('/history?');
    expect(terminalApiSource).not.toContain('/checkpoint');
    expect(terminalApiSource).not.toContain('commitHistoryCheckpoint');
  });

  it('recreates a mirror subscription when either the session or reconnect generation changes', () => {
    expect(appSource).toContain('`${props.sessionId}:${generation()}`');
  });

  it('binds every mounted viewport lifecycle to one immutable session identity', () => {
    expect(appSource).toContain('const mountedSessionId = props.sessionId;');
    expect(appSource).toContain('props.transport.forgetSession(mountedSessionId);');
    expect(appSource).not.toContain('props.transport.forgetSession(props.sessionId);');
  });

  it('binds every semantic renderer to the current view-local theme palette', () => {
    expect(appSource).toContain('getThemeColors');
    expect(appSource.match(/setPalette\(getThemeColors\(props\.themeName\)\)/g)).toHaveLength(2);
    expect(appSource.match(/const palette = getThemeColors\(props\.themeName\);/g)).toHaveLength(2);
    expect(appSource.match(/setPalette\(palette\)/g)).toHaveLength(2);
    expect(appSource.match(/<SemanticTerminalViewport[\s\S]*?themeName=\{props\.themeName\}/g)).toHaveLength(2);
  });

  it('uses the shared composition-aware input bridge and cursor-anchored editable element', () => {
    expect(appSource).toContain('new TerminalInputBridge({');
    expect(appSource).toContain('onInputIntent: props.sendInputIntent');
    expect(appSource).not.toContain('terminalKeyInput');
    expect(appSource).not.toContain('onKeyDown={event => {\n          const value =');
    expect(appSource).toContain('renderer()?.getCursorClientRect()');
    expect(appSource).not.toContain('onInput={event =>');
    expect(stylesSource).toMatch(/\.terminalInputBridge\s*\{[^}]*position:\s*fixed;/);
    expect(stylesSource).not.toMatch(/\.terminalInputBridge\s*\{[^}]*inset:\s*0;/);
    expect(stylesSource).toMatch(/\.semanticTerminalSurface\s*\{[^}]*pointer-events:\s*auto;/);
  });

  it('settles explicit view activation before focus can emit terminal input', () => {
    const pointerDown = appSource.slice(
      appSource.indexOf('onPointerDown={event => {'),
      appSource.indexOf('onPointerMove={event => {'),
    );
    expect(pointerDown).toContain('props.activate?.();');
    expect(pointerDown.indexOf('props.activate?.();')).toBeLessThan(pointerDown.indexOf('inputController?.focus();'));
    expect(appSource).toContain('props.transport.activate(mountedSessionId, dimensions.cols, dimensions.rows)');
    expect(appSource).toContain('if (activationPending || !connected()) return;');
  });
});
