//go:build floeterm_native

#include "generated/adapter.c"

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
