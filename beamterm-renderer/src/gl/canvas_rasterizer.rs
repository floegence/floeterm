//! Canvas-based glyph rasterizer for dynamic font atlas generation.
//!
//! Uses the browser's native text rendering via OffscreenCanvas to rasterize
//! glyphs on demand. This approach handles:
//! - Color emoji (COLR/CBDT/SVG fonts)
//! - Complex emoji sequences (ZWJ, skin tones)
//! - CJK and other fullwidth characters
//! - Ligatures (when supported by the font)
//! - Font fallback chains (handled by browser)
//! - Per-glyph font styles (normal, bold, italic, bold-italic)
//!
//! # Example
//!
//! ```ignore
//! use beamterm_data::FontStyle;
//!
//! let rasterizer = CanvasRasterizer::new("'JetBrains Mono', monospace", 16.0)?;
//!
//! // Batch rasterize glyphs with per-glyph styles
//! let glyphs = rasterizer.rasterize(&[
//!     ("A", FontStyle::Normal),
//!     ("B", FontStyle::Bold),
//!     ("C", FontStyle::Italic),
//!     ("🚀", FontStyle::Normal),  // emoji always uses Normal
//! ])?;
//!
//! // Double-width glyphs (emoji, CJK) have width = cell_width * 2
//! for glyph in &glyphs {
//!     println!("{}x{}", glyph.width, glyph.height);
//! }
//! ```

use beamterm_data::{FontAtlasData, FontStyle};
use compact_str::CompactString;
use wasm_bindgen::prelude::*;
use web_sys::{OffscreenCanvas, OffscreenCanvasRenderingContext2d};

use crate::error::Error;

// padding around glyphs matches StaticFontAtlas to unify texture packing.
const PADDING: u32 = FontAtlasData::PADDING as u32;

const OFFSCREEN_CANVAS_WIDTH: u32 = 256;

/// Number of glyphs per rasterization batch.
/// Canvas height is scaled to fit this many glyphs.
const GLYPH_BATCH_SIZE: usize = 32;

/// Cell metrics for positioning glyphs correctly.
#[derive(Debug, Clone, Copy)]
pub(super) struct CellMetrics {
    padded_width: u32,
    padded_height: u32,
    /// Alphabetic baseline offset from the top of the unpadded typographic line box.
    baseline: f64,
}

/// Re-export core's RasterizedGlyph for use within the renderer.
pub(crate) use beamterm_core::gl::RasterizedGlyph;

/// Canvas-based glyph rasterizer using OffscreenCanvas.
///
/// This rasterizer leverages the browser's native text rendering capabilities
/// to handle complex Unicode rendering including emoji and fullwidth characters.
pub(crate) struct CanvasRasterizer {
    canvas: OffscreenCanvas,
    render_ctx: OffscreenCanvasRenderingContext2d,
    font_family: CompactString,
    font_size: f32,
    cell_metrics: CellMetrics,
}

impl CanvasRasterizer {
    /// Creates a new canvas rasterizer with the specified cell dimensions.
    ///
    /// # Returns
    ///
    /// A configured rasterizer context, or an error if canvas creation fails.
    pub(crate) fn new(font_family: &str, font_size: f32) -> Result<Self, Error> {
        // Create canvas with minimal height for initial measurement
        let canvas = OffscreenCanvas::new(OFFSCREEN_CANVAS_WIDTH, 128)
            .map_err(|e| Error::rasterizer_canvas_creation_failed(js_error_string(&e)))?;

        let context_options = js_sys::Object::new();
        js_sys::Reflect::set(
            context_options.as_ref(),
            &JsValue::from_str("willReadFrequently"),
            &JsValue::TRUE,
        )
        .map_err(|e| Error::rasterizer_canvas_creation_failed(js_error_string(&e)))?;
        let ctx = canvas
            .get_context_with_context_options("2d", context_options.as_ref())
            .map_err(|e| Error::rasterizer_canvas_creation_failed(js_error_string(&e)))?
            .ok_or_else(Error::rasterizer_context_failed)?
            .dyn_into::<OffscreenCanvasRenderingContext2d>()
            .map_err(|_| Error::rasterizer_context_failed())?;

        let font_string = build_font_string(font_family, font_size, FontStyle::Normal);

        ctx.set_text_baseline("alphabetic");
        ctx.set_text_align("left");
        ctx.set_font(&font_string);

        let cell_metrics = Self::measure_cell_metrics(&ctx)?;

        // Resize canvas to fit GLYPH_BATCH_SIZE glyphs
        let required_height = GLYPH_BATCH_SIZE as u32 * cell_metrics.padded_height;
        canvas.set_height(required_height);

        // Re-initialize context after resize (canvas resize clears context state)
        ctx.set_text_baseline("alphabetic");
        ctx.set_text_align("left");
        ctx.set_font(&font_string);

        Ok(Self {
            canvas,
            render_ctx: ctx,
            font_family: CompactString::new(font_family),
            font_size,
            cell_metrics,
        })
    }

    /// Returns the maximum number of glyphs that fit in a single rasterization batch.
    ///
    /// The canvas is sized to fit exactly this many glyphs.
    #[allow(clippy::unused_self)] // consistent with GlyphRasterizer trait interface
    pub(crate) fn max_batch_size(&self) -> usize {
        GLYPH_BATCH_SIZE
    }

    /// Rasterizes all glyphs and returns them as a vector.
    ///
    /// Each glyph is paired with its font style. Emoji glyphs always use
    /// `FontStyle::Normal` regardless of the requested style.
    ///
    /// Glyphs are drawn vertically on the canvas (one per row) and extracted
    /// with a single `getImageData()` call for efficiency.
    ///
    /// Double-width glyphs (emoji, CJK) will have `width = cell_width * 2`.
    pub(crate) fn rasterize(
        &self,
        symbols: &[(&str, FontStyle)],
    ) -> Result<Vec<RasterizedGlyph>, Error> {
        if symbols.is_empty() {
            return Ok(Vec::new());
        }

        self.render_ctx.set_fill_style_str("white");

        let base_font = build_font_string(&self.font_family, self.font_size, FontStyle::Normal);
        self.render_ctx.set_font(&base_font);

        let cell_w = self.cell_metrics.padded_width;
        let cell_h = self.cell_metrics.padded_height;

        let num_glyphs = symbols.len() as u32;

        // canvas needs to be double-width (for emoji) and tall enough for all glyphs
        let canvas_width = cell_w * 2;
        let canvas_height = cell_h * num_glyphs;

        self.render_ctx.clear_rect(
            0.0,
            0.0,
            self.canvas.width() as f64,
            self.canvas.height() as f64,
        );

        let mut current_style: Option<FontStyle> = Some(FontStyle::Normal);
        let y_offset = PADDING as f64 + self.cell_metrics.baseline;

        // draw each glyph on its own row with clipping to prevent bleed
        for (i, &(grapheme, style)) in symbols.iter().enumerate() {
            // emoji always uses normal style (no bold/italic variants)
            let effective_style =
                if beamterm_core::is_emoji(grapheme) { FontStyle::Normal } else { style };

            // update font if style changed
            if current_style != Some(effective_style) {
                let font = build_font_string(&self.font_family, self.font_size, effective_style);
                self.render_ctx.set_font(&font);
                current_style = Some(effective_style);
            }

            let y = (i as u32 * cell_h) as f64;

            // clip to this glyph's cell area to prevent bleeding into adjacent glyphs
            self.render_ctx.save();
            self.render_ctx.begin_path();
            self.render_ctx
                .rect(0.0, y, canvas_width as f64, cell_h as f64);
            self.render_ctx.clip();

            self.render_ctx
                .fill_text(grapheme, PADDING as f64, y + y_offset)
                .map_err(|e| Error::rasterizer_fill_text_failed(grapheme, js_error_string(&e)))?;

            self.render_ctx.restore();
        }

        // extract all pixels at once
        let image_data = self
            .render_ctx
            .get_image_data(0.0, 0.0, canvas_width as f64, canvas_height as f64)
            .map_err(|e| Error::rasterizer_get_image_data_failed(js_error_string(&e)))?;
        let all_pixels = image_data.data().to_vec();

        // split into individual glyphs
        let bytes_per_pixel = 4usize;
        let row_stride = canvas_width as usize * bytes_per_pixel;
        let glyph_stride = cell_h as usize * row_stride;

        let mut results = Vec::with_capacity(symbols.len());

        for (i, &(grapheme, _)) in symbols.iter().enumerate() {
            let padded_width =
                if beamterm_core::is_double_width(grapheme) { cell_w * 2 } else { cell_w };

            let glyph_start = i * glyph_stride;
            let mut pixels = Vec::with_capacity((padded_width * cell_h) as usize * bytes_per_pixel);

            // extract rows, include padding
            for row in 0..cell_h as usize {
                let row_start = glyph_start + row * row_stride;
                let row_end = row_start + (padded_width as usize * bytes_per_pixel);
                pixels.extend_from_slice(&all_pixels[row_start..row_end]);
            }

            results.push(RasterizedGlyph::new(pixels, padded_width, cell_h));
        }

        Ok(results)
    }

    /// Returns the font family string used by this rasterizer.
    pub(super) fn font_family(&self) -> &str {
        &self.font_family
    }

    /// Measures the monospace advance and font line box used for terminal layout.
    ///
    /// Visible glyph bounds are deliberately not used here. Ink bounds describe
    /// one particular glyph, while a terminal cell must use the font's advance
    /// and full line box so that different glyphs and adjacent rows cannot overlap.
    fn measure_cell_metrics(
        render_ctx: &OffscreenCanvasRenderingContext2d,
    ) -> Result<CellMetrics, Error> {
        let metrics = render_ctx
            .measure_text("M")
            .map_err(|e| Error::rasterizer_measure_failed(js_error_string(&e)))?;
        resolve_typographic_cell_metrics(
            metrics.width(),
            metrics.font_bounding_box_ascent(),
            metrics.font_bounding_box_descent(),
        )
        .ok_or_else(|| Error::rasterizer_measure_failed(
            "browser returned invalid monospace advance or font line-box metrics".to_string(),
        ))
    }
}

fn resolve_typographic_cell_metrics(
    advance_width: f64,
    font_ascent: f64,
    font_descent: f64,
) -> Option<CellMetrics> {
    let line_height = font_ascent + font_descent;
    if !advance_width.is_finite()
        || !font_ascent.is_finite()
        || !font_descent.is_finite()
        || advance_width <= 0.0
        || font_ascent <= 0.0
        || font_descent < 0.0
        || line_height <= 0.0
    {
        return None;
    }

    let width = advance_width.round().max(1.0) as u32;
    let height = line_height.round().max(1.0) as u32;
    Some(CellMetrics {
        padded_width: width + 2 * PADDING,
        padded_height: height + 2 * PADDING,
        baseline: font_ascent,
    })
}

/// Converts a JsValue error to a displayable string for error messages.
fn js_error_string(err: &JsValue) -> String {
    err.as_string()
        .unwrap_or_else(|| format!("{err:?}"))
}

/// Builds a CSS font string with style modifiers.
fn build_font_string(font_family: &str, font_size: f32, style: FontStyle) -> String {
    let (bold, italic) = match style {
        FontStyle::Normal => (false, false),
        FontStyle::Bold => (true, false),
        FontStyle::Italic => (false, true),
        FontStyle::BoldItalic => (true, true),
    };

    let style_str = if italic { "italic " } else { "" };
    let weight = if bold { "bold " } else { "" };

    format!("{style_str}{weight}{font_size}px {font_family}, monospace")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typographic_metrics_use_font_advance_and_line_box_instead_of_visible_ink_bounds() {
        let metrics = resolve_typographic_cell_metrics(6.0, 11.0, 4.0)
            .expect("valid browser font metrics");

        assert_eq!(metrics.padded_width, 6 + 2 * PADDING);
        assert_eq!(metrics.padded_height, 15 + 2 * PADDING);
        assert_eq!(metrics.baseline, 11.0);
    }

    #[test]
    fn typographic_metrics_round_physical_pixels_without_collapsing_the_line_box() {
        let metrics = resolve_typographic_cell_metrics(14.449_218_75, 21.4, 6.6)
            .expect("valid fractional browser font metrics");

        assert_eq!(metrics.padded_width, 14 + 2 * PADDING);
        assert_eq!(metrics.padded_height, 28 + 2 * PADDING);
        assert_eq!(metrics.baseline, 21.4);
    }

    #[test]
    fn typographic_metrics_reject_non_finite_or_empty_browser_metrics() {
        assert!(resolve_typographic_cell_metrics(f64::NAN, 11.0, 4.0).is_none());
        assert!(resolve_typographic_cell_metrics(6.0, 0.0, 0.0).is_none());
        assert!(resolve_typographic_cell_metrics(0.0, 11.0, 4.0).is_none());
    }

    #[test]
    fn test_build_font_string() {
        assert_eq!(
            build_font_string("'Hack'", 16.0, FontStyle::Normal),
            "16px 'Hack', monospace"
        );
        assert_eq!(
            build_font_string("'Hack'", 16.0, FontStyle::Bold),
            "bold 16px 'Hack', monospace"
        );
        assert_eq!(
            build_font_string("'Hack'", 16.0, FontStyle::Italic),
            "italic 16px 'Hack', monospace"
        );
        assert_eq!(
            build_font_string("'Hack'", 16.0, FontStyle::BoldItalic),
            "italic bold 16px 'Hack', monospace"
        );
    }
}
