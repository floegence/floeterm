# @floegence/beamterm-renderer

This package is the FloeTerm-maintained distribution of Beamterm's WebGL2 renderer.
It preserves the Beamterm 1.0.0 JavaScript API used by `@floegence/floeterm-terminal-web`.

The fork exists so FloeTerm can own the complete renderer release and test lifecycle.
Its first change makes the dynamic font atlas declare frequent Canvas2D pixel readback
when creating its offscreen context. This matches the atlas implementation, which uses
`getImageData()` for glyph measurement and batched rasterization.

The package also exposes `BeamtermRenderer.withDynamicAtlasCanvas(...)`, which accepts
the owning `HTMLCanvasElement` directly. FloeTerm uses this API so renderer startup is
independent of document attachment timing and document-wide selector lookup.

Builds require Rust 1.90, the `wasm32-unknown-unknown` target, and `wasm-pack`.
