use beamterm_core::gl::{Drawable, GlState, RenderContext};
use glow::HasContext;
use web_sys::HtmlCanvasElement;

use crate::{error::Error, js};

const MAX_RETAINED_BACKING_AXIS_PX: i32 = 8192;
const MAX_RETAINED_BACKING_BYTES: i64 = 64 * 1024 * 1024;

/// High-level WebGL2 renderer for terminal-style applications.
///
/// The `Renderer` manages the WebGL2 rendering context, canvas, and provides
/// a simplified interface for rendering drawable objects. It handles frame
/// management, viewport setup, and coordinate system transformations.
pub struct Renderer {
    gl: glow::Context,
    raw_gl: web_sys::WebGl2RenderingContext, // for is_context_lost() only
    canvas: web_sys::HtmlCanvasElement,
    state: GlState,
    canvas_padding_color: (f32, f32, f32),
    logical_size_px: (i32, i32),
    backing_size_px: (i32, i32),
    pixel_ratio: f32,
    backing_pixel_ratio: f32,
    auto_resize_canvas_css: bool,
}

impl std::fmt::Debug for Renderer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Renderer")
            .field("canvas_padding_color", &self.canvas_padding_color)
            .field("logical_size_px", &self.logical_size_px)
            .field("pixel_ratio", &self.pixel_ratio)
            .field("auto_resize_canvas_css", &self.auto_resize_canvas_css)
            .finish_non_exhaustive()
    }
}

impl Renderer {
    /// Creates a new renderer by querying for a canvas element with the given ID.
    ///
    /// # Errors
    ///
    /// Returns an error if the canvas element cannot be found or the WebGL2 context
    /// cannot be created.
    pub fn create(canvas_id: &str, auto_resize_canvas_css: bool) -> Result<Self, Error> {
        let canvas = js::get_canvas_by_id(canvas_id)?;
        Self::create_with_canvas(canvas, auto_resize_canvas_css)
    }

    /// Sets the background color for the canvas area outside the terminal grid.
    #[must_use]
    pub fn canvas_padding_color(mut self, color: u32) -> Self {
        self.canvas_padding_color = unpack_rgb(color);
        self
    }

    /// Updates the background color for the canvas area outside the terminal grid.
    pub fn set_canvas_padding_color(&mut self, color: u32) {
        self.canvas_padding_color = unpack_rgb(color);
    }

    /// Creates a new renderer from an existing HTML canvas element.
    ///
    /// # Errors
    ///
    /// Returns an error if the WebGL2 context cannot be created from the canvas.
    pub fn create_with_canvas(
        canvas: HtmlCanvasElement,
        auto_resize_canvas_css: bool,
    ) -> Result<Self, Error> {
        let (width, height) = (canvas.width() as i32, canvas.height() as i32);

        // initialize WebGL context
        let (gl, raw_gl) = js::create_glow_context(&canvas)?;
        let state = GlState::new(&gl);

        let mut renderer = Self {
            gl,
            raw_gl,
            canvas,
            state,
            canvas_padding_color: (0.0, 0.0, 0.0),
            logical_size_px: (width, height),
            backing_size_px: (0, 0),
            pixel_ratio: 1.0,
            backing_pixel_ratio: 1.0,
            auto_resize_canvas_css,
        };
        renderer.resize(width as _, height as _);
        Ok(renderer)
    }

    /// Resizes the canvas and updates the viewport.
    pub fn resize(&mut self, width: i32, height: i32) {
        self.logical_size_px = (width, height);
        let target_size = self.physical_size();
        let reset_backing =
            self.backing_size_px != (0, 0) && self.pixel_ratio != self.backing_pixel_ratio;
        let next_backing = resolve_backing_size(self.backing_size_px, target_size, reset_backing);

        if next_backing != self.backing_size_px {
            self.canvas.set_width(next_backing.0.max(1) as u32);
            self.canvas.set_height(next_backing.1.max(1) as u32);
            self.backing_size_px = next_backing;
            self.backing_pixel_ratio = self.pixel_ratio;
        }

        if self.auto_resize_canvas_css {
            let _ = self.canvas.style().set_property(
                "width",
                &format!("{}px", next_backing.0 as f32 / self.pixel_ratio),
            );
            let _ = self.canvas.style().set_property(
                "height",
                &format!("{}px", next_backing.1 as f32 / self.pixel_ratio),
            );
        }

        let viewport = resolve_logical_viewport(next_backing, target_size);
        self.state
            .viewport(&self.gl, viewport.0, viewport.1, viewport.2, viewport.3);
    }

    /// Clears the framebuffer with the specified color.
    pub fn clear(&mut self, r: f32, g: f32, b: f32) {
        self.state.clear_color(&self.gl, r, g, b, 1.0);
        unsafe {
            self.gl
                .clear(glow::COLOR_BUFFER_BIT | glow::DEPTH_BUFFER_BIT);
        };
    }

    /// Begins a new rendering frame.
    pub fn begin_frame(&mut self) {
        let (r, g, b) = self.canvas_padding_color;
        self.clear(r, g, b);
    }

    /// Renders a drawable object.
    ///
    /// # Errors
    ///
    /// Returns an error if the drawable's `prepare` step fails (e.g., GPU buffer
    /// upload or shader compilation errors).
    pub fn render(&mut self, drawable: &impl Drawable) -> Result<(), crate::Error> {
        let mut context = RenderContext {
            gl: &self.gl,
            state: &mut self.state,
        };

        drawable.prepare(&mut context)?;
        drawable.draw(&mut context);
        drawable.cleanup(&mut context);
        Ok(())
    }

    /// Ends the current rendering frame.
    pub fn end_frame(&mut self) {
        // swap buffers (todo)
    }

    /// Returns a reference to the glow rendering context.
    pub fn gl(&self) -> &glow::Context {
        &self.gl
    }

    /// Returns a reference to the HTML canvas element.
    pub fn canvas(&self) -> &HtmlCanvasElement {
        &self.canvas
    }

    /// Returns the current canvas dimensions as a tuple.
    pub fn canvas_size(&self) -> (i32, i32) {
        self.logical_size()
    }

    /// Returns the logical size of the canvas in pixels.
    pub fn logical_size(&self) -> (i32, i32) {
        self.logical_size_px
    }

    /// Returns the physical size of the canvas in pixels, taking into account the device
    /// pixel ratio.
    pub fn physical_size(&self) -> (i32, i32) {
        let (w, h) = self.logical_size_px;
        (
            (w as f32 * self.pixel_ratio).round() as i32,
            (h as f32 * self.pixel_ratio).round() as i32,
        )
    }

    /// Checks if the WebGL context has been lost.
    pub fn is_context_lost(&self) -> bool {
        self.raw_gl.is_context_lost()
    }

    /// Restores the WebGL context after a context loss event.
    ///
    /// # Errors
    ///
    /// Returns an error if the new WebGL2 context cannot be created.
    pub fn restore_context(&mut self) -> Result<(), Error> {
        let (gl, raw_gl) = js::create_glow_context(&self.canvas)?;
        self.state = GlState::new(&gl);
        self.gl = gl;
        self.raw_gl = raw_gl;

        // Restore the logical viewport at the visible top of retained backing.
        let viewport = resolve_logical_viewport(self.backing_size_px, self.physical_size());
        self.state
            .viewport(&self.gl, viewport.0, viewport.1, viewport.2, viewport.3);

        Ok(())
    }

    /// Sets the pixel ratio.
    pub(crate) fn set_pixel_ratio(&mut self, pixel_ratio: f32) {
        self.pixel_ratio = pixel_ratio;
    }
}

fn resolve_backing_size(current: (i32, i32), requested: (i32, i32), reset: bool) -> (i32, i32) {
    if reset {
        return requested;
    }
    let resolve_axis = |current_axis: i32, requested_axis: i32| {
        if current_axis > requested_axis.saturating_mul(2) {
            requested_axis
        } else {
            current_axis.max(requested_axis)
        }
    };
    let retained = (
        resolve_axis(current.0, requested.0),
        resolve_axis(current.1, requested.1),
    );
    let retained_bytes = i64::from(retained.0.max(0))
        .saturating_mul(i64::from(retained.1.max(0)))
        .saturating_mul(4);
    if retained.0 > MAX_RETAINED_BACKING_AXIS_PX
        || retained.1 > MAX_RETAINED_BACKING_AXIS_PX
        || retained_bytes > MAX_RETAINED_BACKING_BYTES
    {
        requested
    } else {
        retained
    }
}

fn resolve_logical_viewport(backing: (i32, i32), logical: (i32, i32)) -> (i32, i32, i32, i32) {
    (0, backing.1.saturating_sub(logical.1), logical.0, logical.1)
}

fn unpack_rgb(color: u32) -> (f32, f32, f32) {
    (
        ((color >> 16) & 0xFF) as f32 / 255.0,
        ((color >> 8) & 0xFF) as f32 / 255.0,
        (color & 0xFF) as f32 / 255.0,
    )
}

#[cfg(test)]
mod tests {
    use super::{resolve_backing_size, resolve_logical_viewport, unpack_rgb};

    #[test]
    fn unpacks_canvas_padding_color_as_normalized_rgb() {
        assert_eq!(unpack_rgb(0x000000), (0.0, 0.0, 0.0));
        assert_eq!(unpack_rgb(0xFFFFFF), (1.0, 1.0, 1.0));
        let (red, green, blue) = unpack_rgb(0x1A2B3C);
        assert!((red - 26.0 / 255.0).abs() < f32::EPSILON);
        assert!((green - 43.0 / 255.0).abs() < f32::EPSILON);
        assert!((blue - 60.0 / 255.0).abs() < f32::EPSILON);
    }

    #[test]
    fn retains_backing_capacity_within_a_bounded_regrowth_window() {
        assert_eq!(
            resolve_backing_size((1200, 700), (700, 500), false),
            (1200, 700),
        );
        assert_eq!(
            resolve_backing_size((1200, 700), (1100, 650), false),
            (1200, 700),
        );
        assert_eq!(
            resolve_backing_size((1200, 700), (1400, 800), false),
            (1400, 800),
        );
        assert_eq!(
            resolve_backing_size((1200, 700), (700, 500), true),
            (700, 500),
        );
        assert_eq!(
            resolve_backing_size((2400, 1400), (700, 500), false),
            (700, 500),
        );
        assert_eq!(
            resolve_backing_size((1400, 1000), (700, 500), false),
            (1400, 1000),
        );
        assert_eq!(
            resolve_backing_size((8192, 4096), (1200, 700), false),
            (1200, 700),
        );
        assert_eq!(
            resolve_backing_size((9000, 700), (9000, 700), false),
            (9000, 700),
        );
    }

    #[test]
    fn retained_backing_keeps_logical_row_zero_at_the_visible_canvas_top() {
        assert_eq!(
            resolve_logical_viewport((1200, 700), (700, 500)),
            (0, 200, 700, 500),
        );
        assert_eq!(
            resolve_logical_viewport((700, 500), (700, 500)),
            (0, 0, 700, 500)
        );
    }
}
