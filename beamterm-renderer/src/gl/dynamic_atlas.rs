use beamterm_core::gl::{GlyphRasterizer, RasterizedGlyph};
use beamterm_data::{CellSize, FontAtlasData, FontStyle, LineDecoration};

use super::canvas_rasterizer::CanvasRasterizer;
use crate::error::Error;

fn resolve_underline_decoration(
    baseline: f64,
    descent: f64,
    cell_height: u32,
    pixel_ratio: f32,
) -> LineDecoration {
    let cell_height = f64::from(cell_height.max(1));
    let pixel_ratio = f64::from(pixel_ratio.max(f32::EPSILON));
    let half_thickness = (0.5 * pixel_ratio).min(cell_height / 2.0);
    let baseline_offset = (descent / 2.0).clamp(0.5 * pixel_ratio, pixel_ratio);
    let raw_center = baseline + baseline_offset;
    let pixel_aligned_center = raw_center.ceil() - 0.5;
    let center = pixel_aligned_center
        .clamp(baseline + 0.5 * pixel_ratio, baseline + pixel_ratio)
        .clamp(half_thickness, cell_height - half_thickness);

    LineDecoration::new(
        (center / cell_height) as f32,
        (half_thickness / cell_height) as f32,
    )
}

/// Canvas-based glyph rasterizer for WASM/browser environments.
///
/// Wraps [`CanvasRasterizer`] to implement [`GlyphRasterizer`] for use with
/// [`DynamicFontAtlas`](beamterm_core::gl::DynamicFontAtlas).
pub(crate) struct CanvasGlyphRasterizer {
    inner: CanvasRasterizer,
    cell_size: CellSize,
    base_font_size: f32,
    pixel_ratio: f32,
}

impl CanvasGlyphRasterizer {
    pub(crate) fn new(
        font_family: &str,
        base_font_size: f32,
        pixel_ratio: f32,
    ) -> Result<Self, Error> {
        let inner = CanvasRasterizer::new(font_family, base_font_size * pixel_ratio)?;
        let cell_size = Self::measure_cell_size(&inner)?;
        Ok(Self {
            inner,
            cell_size,
            base_font_size,
            pixel_ratio,
        })
    }

    fn measure_cell_size(rasterizer: &CanvasRasterizer) -> Result<CellSize, Error> {
        let reference_glyphs = rasterizer.rasterize(&[("\u{2588}", FontStyle::Normal)])?;

        if let Some(g) = reference_glyphs.first() {
            Ok(CellSize::new(
                g.width as i32 - FontAtlasData::PADDING * 2,
                g.height as i32 - FontAtlasData::PADDING * 2,
            ))
        } else {
            Err(Error::rasterizer_empty_reference_glyph())
        }
    }
}

impl GlyphRasterizer for CanvasGlyphRasterizer {
    fn rasterize_batch(
        &mut self,
        glyphs: &[(&str, FontStyle)],
    ) -> Result<Vec<RasterizedGlyph>, beamterm_core::Error> {
        self.inner
            .rasterize(glyphs)
            .map_err(|e| beamterm_core::Error::Resource(e.to_string()))
    }

    fn max_batch_size(&self) -> usize {
        self.inner.max_batch_size()
    }

    fn cell_size(&self) -> CellSize {
        self.cell_size
    }

    fn is_double_width(&mut self, _grapheme: &str) -> bool {
        false // Canvas API doesn't expose font advance metrics
    }

    fn underline(&self) -> LineDecoration {
        let metrics = self.inner.cell_metrics();
        resolve_underline_decoration(
            metrics.baseline,
            metrics.descent,
            metrics.height,
            self.pixel_ratio,
        )
    }

    fn strikethrough(&self) -> LineDecoration {
        LineDecoration::new(0.5, 0.05) // middle, thin
    }

    fn update_font_size(&mut self, font_size: f32) -> Result<(), beamterm_core::Error> {
        self.pixel_ratio = font_size / self.base_font_size;
        self.inner = CanvasRasterizer::new(self.inner.font_family(), font_size)
            .map_err(|e| beamterm_core::Error::Resource(e.to_string()))?;
        self.cell_size = Self::measure_cell_size(&self.inner)
            .map_err(|e| beamterm_core::Error::Resource(e.to_string()))?;
        Ok(())
    }
}

/// Type alias for the WASM dynamic font atlas.
pub(crate) type DynamicFontAtlas = beamterm_core::gl::DynamicFontAtlas<CanvasGlyphRasterizer>;

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 0.000_1,
            "expected {expected}, got {actual}",
        );
    }

    #[test]
    fn underline_tracks_baseline_descent_and_one_css_pixel_stroke() {
        let cases = [
            // Regular descent at DPR 1: cap the gap at one physical pixel.
            (11.0, 4.0, 15, 1.0, 11.5 / 15.0, 0.5 / 15.0),
            // Tiny descent: keep the center at least half a CSS pixel below the baseline.
            (10.0, 0.2, 11, 1.0, 10.5 / 11.0, 0.5 / 11.0),
            // Fractional browser metrics at DPR 2: retain a one CSS pixel gap and stroke.
            (21.4, 6.6, 28, 2.0, 23.4 / 28.0, 1.0 / 28.0),
        ];

        for (baseline, descent, cell_height, dpr, expected_position, expected_thickness) in cases {
            let decoration = resolve_underline_decoration(baseline, descent, cell_height, dpr);
            assert_close(decoration.position(), expected_position as f32);
            assert_close(decoration.thickness(), expected_thickness as f32);
        }
    }

    #[test]
    fn underline_is_recomputed_for_font_size_and_dpr_changes() {
        let initial = resolve_underline_decoration(8.0, 3.0, 11, 1.0);
        let resized = resolve_underline_decoration(16.0, 6.0, 22, 2.0);

        assert_close(initial.position(), 8.5 / 11.0);
        assert_close(initial.thickness(), 0.5 / 11.0);
        assert_close(resized.position(), 17.5 / 22.0);
        assert_close(resized.thickness(), 1.0 / 22.0);
    }

    #[test]
    fn underline_never_crosses_the_cell_bottom() {
        let decoration = resolve_underline_decoration(10.4, 0.2, 11, 1.0);
        let center = decoration.position() * 11.0;
        let half_thickness = decoration.thickness() * 11.0;

        assert!(center + half_thickness <= 11.0);
    }
}
