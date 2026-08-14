#ifndef FLOETERM_GATE_NATIVE_ADAPTER_H
#define FLOETERM_GATE_NATIVE_ADAPTER_H

#include <stddef.h>
#include <stdint.h>

typedef struct NativeEngine NativeEngine;
typedef struct NativeAnchor NativeAnchor;

typedef struct {
  uint8_t *data;
  size_t len;
} NativeBytes;

typedef struct {
  int location;
  uint8_t *data;
  size_t len;
} NativeClipboard;

typedef struct {
  uint32_t bells;
  uint8_t *title;
  size_t title_len;
  NativeBytes *responses;
  size_t responses_len;
  NativeClipboard *clipboard;
  size_t clipboard_len;
} NativeOutputResult;

typedef struct {
  size_t text_offset;
  size_t text_len;
  int width;
  int foreground_kind;
  uint8_t foreground_r;
  uint8_t foreground_g;
  uint8_t foreground_b;
  uint8_t foreground_index;
  int background_kind;
  uint8_t background_r;
  uint8_t background_g;
  uint8_t background_b;
  uint8_t background_index;
  int underline;
  uint8_t bold;
  uint8_t italic;
  uint8_t faint;
  uint8_t blink;
  uint8_t inverse;
  uint8_t invisible;
  uint8_t strikethrough;
  uint8_t overline;
  size_t hyperlink_offset;
  size_t hyperlink_len;
} NativeCell;

typedef struct {
  uint32_t id;
  uint32_t width;
  uint32_t height;
  int format;
  uint64_t generation;
  uint8_t *pixels;
  size_t pixels_len;
} NativeImage;

typedef struct {
  uint32_t image_id;
  uint32_t placement_id;
  int32_t z;
  int32_t viewport_col;
  int32_t viewport_row;
  uint32_t grid_cols;
  uint32_t grid_rows;
  uint8_t visible;
  uint8_t is_virtual;
} NativePlacement;

typedef struct {
  uint16_t width;
  uint16_t height;
  uint16_t cursor_x;
  uint16_t cursor_y;
  uint8_t cursor_visible;
  int active_screen;
  uint8_t mode_origin;
  uint8_t mode_bracketed_paste;
  uint8_t *data;
  size_t data_len;
  size_t *row_offsets;
  NativeCell *cells;
  uint64_t graphics_generation;
  NativeImage *images;
  size_t images_len;
  NativePlacement *placements;
  size_t placements_len;
} NativeFrame;

NativeEngine *native_engine_new(uint16_t width, uint16_t height);
void native_engine_free(NativeEngine *engine);
void native_engine_write(NativeEngine *engine, const uint8_t *data, size_t len);
int native_engine_resize(NativeEngine *engine, uint16_t width, uint16_t height,
                         uint32_t cell_width, uint32_t cell_height);
void native_engine_reset(NativeEngine *engine);
int native_engine_write_events(NativeEngine *engine, const uint8_t *data, size_t len,
                               NativeOutputResult *result);
void native_output_result_free(NativeOutputResult *result);
int native_encode_paste(const uint8_t *data, size_t len, uint8_t bracketed,
                        NativeBytes *output);
int native_encode_focus(uint8_t focused, NativeBytes *output);
int native_encode_key(NativeEngine *engine, int key, int action, uint16_t mods,
                      const uint8_t *text, size_t text_len, NativeBytes *output);
int native_encode_mouse(NativeEngine *engine, int action, int button, uint16_t mods,
                        float x, float y, NativeBytes *output);
void native_bytes_free(NativeBytes *output);
int native_capture_frame(NativeEngine *engine, NativeFrame *frame);
void native_frame_free(NativeFrame *frame);
NativeAnchor *native_track_screen_cell(NativeEngine *engine, uint16_t x, uint32_t y);
void native_anchor_free(NativeAnchor *anchor);
int native_viewport_active(NativeEngine *engine, uint8_t *active);
int native_read_history(NativeEngine *engine, NativeAnchor *anchor, uint16_t limit,
                        NativeFrame *page);
void native_test_fatal(void);

#endif
