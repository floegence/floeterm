//go:build floeterm_native

#include "generated/adapter.c"

// Keep the cursor contract in the same render-state ownership window as the
// bulk frame capture. The public Ghostty render API is the authority; this
// wrapper only copies scalar values across the cgo boundary.
typedef struct {
  uint16_t x;
  uint16_t y;
  uint8_t visible;
  uint8_t blinking;
  uint8_t shape;
  uint8_t wide_tail;
  uint8_t color_has_value;
  uint8_t color_r;
  uint8_t color_g;
  uint8_t color_b;
} FloetermCursorInfo;

int floeterm_native_cursor_info(NativeEngine *engine, FloetermCursorInfo *out) {
  if (engine == NULL || out == NULL) return 0;
  memset(out, 0, sizeof(*out));
  bool has_viewport = false;
  bool cursor_visible = false;
  bool cursor_blinking = false;
  bool cursor_wide_tail = false;
  bool color_has_value = false;
  GhosttyRenderStateCursorVisualStyle shape =
      GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  GhosttyColorRgb color = {0};
  if (ghostty_render_state_get(engine->render,
                               GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE,
                               &cursor_visible) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(engine->render,
                               GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING,
                               &cursor_blinking) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(engine->render,
                               GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE,
                               &shape) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(engine->render,
                               GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
                               &has_viewport) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(engine->render,
                               GHOSTTY_RENDER_STATE_DATA_COLOR_CURSOR_HAS_VALUE,
                               &color_has_value) != GHOSTTY_SUCCESS)
    return 0;
  if (has_viewport &&
      (ghostty_render_state_get(engine->render,
                                GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X,
                                &out->x) != GHOSTTY_SUCCESS ||
       ghostty_render_state_get(engine->render,
                                GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y,
                                &out->y) != GHOSTTY_SUCCESS ||
       ghostty_render_state_get(engine->render,
                                GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_WIDE_TAIL,
                                &cursor_wide_tail) != GHOSTTY_SUCCESS))
    return 0;
  if (color_has_value &&
      ghostty_render_state_get(engine->render,
                               GHOSTTY_RENDER_STATE_DATA_COLOR_CURSOR,
                               &color) != GHOSTTY_SUCCESS)
    return 0;
  out->shape = (uint8_t)shape;
  out->visible = cursor_visible && has_viewport ? 1 : 0;
  out->blinking = cursor_blinking ? 1 : 0;
  out->wide_tail = cursor_wide_tail ? 1 : 0;
  out->color_has_value = color_has_value ? 1 : 0;
  out->color_r = color.r;
  out->color_g = color.g;
  out->color_b = color.b;
  return 1;
}

int floeterm_native_history_total_rows(NativeEngine *engine, size_t *rows) {
  if (engine == NULL || rows == NULL) return 0;
  return ghostty_terminal_get(engine->terminal, GHOSTTY_TERMINAL_DATA_TOTAL_ROWS,
                             rows) == GHOSTTY_SUCCESS;
}

int floeterm_native_anchor_screen_row(NativeAnchor *anchor, uint32_t *row) {
  if (anchor == NULL || row == NULL) return 0;
  GhosttyPointCoordinate point = {0};
  GhosttyResult result = ghostty_tracked_grid_ref_point(
      anchor->ref, GHOSTTY_POINT_TAG_SCREEN, &point);
  if (result == GHOSTTY_NO_VALUE) return 2;
  if (result != GHOSTTY_SUCCESS) return 0;
  *row = point.y;
  return 1;
}
