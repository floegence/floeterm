import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('dynamic atlas explicitly opts into frequent Canvas2D readback', async () => {
  const source = await readFile(new URL('../src/gl/canvas_rasterizer.rs', import.meta.url), 'utf8');
  assert.match(source, /get_context_with_context_options\("2d",/);
  assert.match(source, /"willReadFrequently"/);
  assert.match(source, /JsValue::TRUE/);
});

test('dynamic atlas accepts a direct canvas element without document lookup', async () => {
  const source = await readFile(new URL('../src/wasm.rs', import.meta.url), 'utf8');
  assert.match(source, /js_name = "withDynamicAtlasCanvas"/);
  assert.match(source, /canvas: web_sys::HtmlCanvasElement/);
  assert.match(source, /Terminal::builder\(canvas\)/);
});
