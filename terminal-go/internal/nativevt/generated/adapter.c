#define GHOSTTY_STATIC
#include <ghostty/vt.h>

#include "adapter.h"

#include <stdlib.h>
#include <string.h>

struct NativeEngine {
  GhosttyTerminal terminal;
  GhosttyRenderState render;
  GhosttyKeyEncoder key_encoder;
  GhosttyMouseEncoder mouse_encoder;
  NativeOutputResult pending;
  uint16_t cols;
  uint16_t rows;
  uint32_t cell_width;
  uint32_t cell_height;
};

struct NativeAnchor {
  GhosttyTrackedGridRef ref;
};

static void on_write_pty(GhosttyTerminal terminal, void *userdata,
                         const uint8_t *data, size_t len) {
  (void)terminal;
  NativeEngine *engine = userdata;
  NativeBytes *next = realloc(engine->pending.responses,
                              (engine->pending.responses_len + 1) * sizeof(*next));
  if (next == NULL) return;
  engine->pending.responses = next;
  NativeBytes *response = &next[engine->pending.responses_len];
  response->data = malloc(len);
  if (response->data == NULL) return;
  memcpy(response->data, data, len);
  response->len = len;
  engine->pending.responses_len++;
}

static void on_bell(GhosttyTerminal terminal, void *userdata) {
  (void)terminal;
  NativeEngine *engine = userdata;
  engine->pending.bells++;
}

static void on_title(GhosttyTerminal terminal, void *userdata) {
  NativeEngine *engine = userdata;
  GhosttyString title = {0};
  if (ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_TITLE, &title) !=
      GHOSTTY_SUCCESS)
    return;
  free(engine->pending.title);
  engine->pending.title = NULL;
  engine->pending.title_len = 0;
  if (title.len == 0) return;
  engine->pending.title = malloc(title.len);
  if (engine->pending.title == NULL) return;
  memcpy(engine->pending.title, title.ptr, title.len);
  engine->pending.title_len = title.len;
}

static GhosttyClipboardWriteResult on_clipboard(
    GhosttyTerminal terminal, void *userdata, const GhosttyClipboardWrite *write) {
  (void)terminal;
  NativeEngine *engine = userdata;
  for (size_t i = 0; i < write->contents_len; i++) {
    NativeClipboard *next = realloc(
        engine->pending.clipboard,
        (engine->pending.clipboard_len + 1) * sizeof(*next));
    if (next == NULL) return GHOSTTY_CLIPBOARD_WRITE_RESULT_IO_ERROR;
    engine->pending.clipboard = next;
    NativeClipboard *entry = &next[engine->pending.clipboard_len];
    memset(entry, 0, sizeof(*entry));
    entry->location = write->location;
    entry->len = write->contents[i].data.len;
    if (entry->len != 0) {
      entry->data = malloc(entry->len);
      if (entry->data == NULL) return GHOSTTY_CLIPBOARD_WRITE_RESULT_IO_ERROR;
      memcpy(entry->data, write->contents[i].data.ptr, entry->len);
    }
    engine->pending.clipboard_len++;
  }
  return GHOSTTY_CLIPBOARD_WRITE_RESULT_SUCCESS;
}

NativeEngine *native_engine_new(uint16_t width, uint16_t height) {
  NativeEngine *engine = calloc(1, sizeof(*engine));
  if (engine == NULL) return NULL;
  if (ghostty_terminal_new(NULL, &engine->terminal, width, height) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(NULL, &engine->render) != GHOSTTY_SUCCESS ||
      ghostty_key_encoder_new(NULL, &engine->key_encoder) != GHOSTTY_SUCCESS ||
      ghostty_mouse_encoder_new(NULL, &engine->mouse_encoder) != GHOSTTY_SUCCESS) {
    native_engine_free(engine);
    return NULL;
  }
  if (ghostty_terminal_resize(engine->terminal, width, height, 8, 16) != GHOSTTY_SUCCESS) {
    native_engine_free(engine);
    return NULL;
  }
  engine->cols = width;
  engine->rows = height;
  engine->cell_width = 8;
  engine->cell_height = 16;
  if (ghostty_terminal_set(engine->terminal, GHOSTTY_TERMINAL_OPT_USERDATA,
                          engine) != GHOSTTY_SUCCESS ||
      ghostty_terminal_set(engine->terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY,
                          (const void *)on_write_pty) != GHOSTTY_SUCCESS ||
      ghostty_terminal_set(engine->terminal, GHOSTTY_TERMINAL_OPT_BELL,
                          (const void *)on_bell) != GHOSTTY_SUCCESS ||
      ghostty_terminal_set(engine->terminal, GHOSTTY_TERMINAL_OPT_TITLE_CHANGED,
                          (const void *)on_title) != GHOSTTY_SUCCESS ||
      ghostty_terminal_set(engine->terminal, GHOSTTY_TERMINAL_OPT_CLIPBOARD_WRITE,
                          (const void *)on_clipboard) != GHOSTTY_SUCCESS) {
    native_engine_free(engine);
    return NULL;
  }
  uint64_t graphics_limit = 64 * 1024 * 1024;
  if (ghostty_terminal_set(engine->terminal,
                          GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT,
                          &graphics_limit) != GHOSTTY_SUCCESS) {
    native_engine_free(engine);
    return NULL;
  }
  return engine;
}

void native_engine_free(NativeEngine *engine) {
  if (engine == NULL) return;
  native_output_result_free(&engine->pending);
  ghostty_render_state_free(engine->render);
  ghostty_key_encoder_free(engine->key_encoder);
  ghostty_mouse_encoder_free(engine->mouse_encoder);
  ghostty_terminal_free(engine->terminal);
  free(engine);
}

void native_engine_write(NativeEngine *engine, const uint8_t *data, size_t len) {
  if (engine == NULL || (data == NULL && len != 0)) return;
  ghostty_terminal_vt_write(engine->terminal, data, len);
}

int native_engine_resize(NativeEngine *engine, uint16_t width, uint16_t height,
                         uint32_t cell_width, uint32_t cell_height) {
  if (engine == NULL) return 0;
  if (ghostty_terminal_resize(engine->terminal, width, height, cell_width,
                             cell_height) != GHOSTTY_SUCCESS)
    return 0;
  engine->cols = width;
  engine->rows = height;
  engine->cell_width = cell_width;
  engine->cell_height = cell_height;
  return 1;
}

void native_engine_reset(NativeEngine *engine) {
  if (engine != NULL) ghostty_terminal_reset(engine->terminal);
}

int native_engine_write_events(NativeEngine *engine, const uint8_t *data, size_t len,
                               NativeOutputResult *result) {
  if (engine == NULL || result == NULL || (data == NULL && len != 0)) return 0;
  native_output_result_free(&engine->pending);
  ghostty_terminal_vt_write(engine->terminal, data, len);
  *result = engine->pending;
  memset(&engine->pending, 0, sizeof(engine->pending));
  return 1;
}

void native_output_result_free(NativeOutputResult *result) {
  if (result == NULL) return;
  free(result->title);
  for (size_t i = 0; i < result->responses_len; i++) free(result->responses[i].data);
  for (size_t i = 0; i < result->clipboard_len; i++) free(result->clipboard[i].data);
  free(result->responses);
  free(result->clipboard);
  memset(result, 0, sizeof(*result));
}

int native_encode_paste(const uint8_t *data, size_t len, uint8_t bracketed,
                        NativeBytes *output) {
  if (output == NULL || (data == NULL && len != 0)) return 0;
  memset(output, 0, sizeof(*output));
  char *mutable = len == 0 ? NULL : malloc(len);
  if (len != 0 && mutable == NULL) return 0;
  if (len != 0) memcpy(mutable, data, len);
  size_t required = 0;
  GhosttyResult result = ghostty_paste_encode(mutable, len, bracketed, NULL, 0, &required);
  if (result != GHOSTTY_OUT_OF_SPACE && result != GHOSTTY_SUCCESS) goto fail;
  if (required != 0) {
    output->data = malloc(required);
    if (output->data == NULL) goto fail;
  }
  if (ghostty_paste_encode(mutable, len, bracketed, (char *)output->data,
                          required, &output->len) != GHOSTTY_SUCCESS)
    goto fail;
  free(mutable);
  return 1;
fail:
  free(mutable);
  native_bytes_free(output);
  return 0;
}

int native_encode_focus(uint8_t focused, NativeBytes *output) {
  if (output == NULL) return 0;
  memset(output, 0, sizeof(*output));
  size_t required = 0;
  GhosttyFocusEvent event = focused ? GHOSTTY_FOCUS_GAINED : GHOSTTY_FOCUS_LOST;
  GhosttyResult result = ghostty_focus_encode(event, NULL, 0, &required);
  if (result != GHOSTTY_OUT_OF_SPACE && result != GHOSTTY_SUCCESS) return 0;
  output->data = required == 0 ? NULL : malloc(required);
  if (required != 0 && output->data == NULL) return 0;
  if (ghostty_focus_encode(event, (char *)output->data, required, &output->len) !=
      GHOSTTY_SUCCESS) {
    native_bytes_free(output);
    return 0;
  }
  return 1;
}

int native_encode_key(NativeEngine *engine, int key, int action, uint16_t mods,
                      const uint8_t *text, size_t text_len, NativeBytes *output) {
  if (engine == NULL || output == NULL || (text == NULL && text_len != 0)) return 0;
  memset(output, 0, sizeof(*output));
  GhosttyKeyEvent event = NULL;
  if (ghostty_key_event_new(NULL, &event) != GHOSTTY_SUCCESS) return 0;
  ghostty_key_encoder_setopt_from_terminal(engine->key_encoder, engine->terminal);
  GhosttyKey mapped_key;
  switch (key) {
    case 1: mapped_key = GHOSTTY_KEY_ARROW_UP; break;
    default: goto fail;
  }
  GhosttyKeyAction mapped_action;
  switch (action) {
    case 1: mapped_action = GHOSTTY_KEY_ACTION_PRESS; break;
    case 2: mapped_action = GHOSTTY_KEY_ACTION_REPEAT; break;
    case 3: mapped_action = GHOSTTY_KEY_ACTION_RELEASE; break;
    default: goto fail;
  }
  ghostty_key_event_set_key(event, mapped_key);
  ghostty_key_event_set_action(event, mapped_action);
  ghostty_key_event_set_mods(event, mods);
  ghostty_key_event_set_utf8(event, (const char *)text, text_len);
  size_t required = 0;
  GhosttyResult result = ghostty_key_encoder_encode(engine->key_encoder, event,
                                                     NULL, 0, &required);
  if (result != GHOSTTY_OUT_OF_SPACE && result != GHOSTTY_SUCCESS) goto fail;
  output->data = required == 0 ? NULL : malloc(required);
  if (required != 0 && output->data == NULL) goto fail;
  if (ghostty_key_encoder_encode(engine->key_encoder, event,
                                 (char *)output->data, required,
                                 &output->len) != GHOSTTY_SUCCESS)
    goto fail;
  ghostty_key_event_free(event);
  return 1;
fail:
  ghostty_key_event_free(event);
  native_bytes_free(output);
  return 0;
}

int native_encode_mouse(NativeEngine *engine, int action, int button, uint16_t mods,
                        float x, float y, NativeBytes *output) {
  if (engine == NULL || output == NULL) return 0;
  memset(output, 0, sizeof(*output));
  GhosttyMouseEvent event = NULL;
  if (ghostty_mouse_event_new(NULL, &event) != GHOSTTY_SUCCESS) return 0;
  ghostty_mouse_encoder_setopt_from_terminal(engine->mouse_encoder, engine->terminal);
  GhosttyMouseEncoderSize size = GHOSTTY_INIT_SIZED(GhosttyMouseEncoderSize);
  size.screen_width = engine->cell_width * engine->cols;
  size.screen_height = engine->cell_height * engine->rows;
  size.cell_width = engine->cell_width;
  size.cell_height = engine->cell_height;
  ghostty_mouse_encoder_setopt(engine->mouse_encoder, GHOSTTY_MOUSE_ENCODER_OPT_SIZE,
                               &size);
  GhosttyMouseAction mapped_action;
  switch (action) {
    case 1: mapped_action = GHOSTTY_MOUSE_ACTION_PRESS; break;
    case 2: mapped_action = GHOSTTY_MOUSE_ACTION_RELEASE; break;
    case 3: mapped_action = GHOSTTY_MOUSE_ACTION_MOTION; break;
    default: goto fail;
  }
  ghostty_mouse_event_set_action(event, mapped_action);
  if (button == 0) ghostty_mouse_event_clear_button(event);
  else if (button == 1) ghostty_mouse_event_set_button(event, GHOSTTY_MOUSE_BUTTON_LEFT);
  else goto fail;
  ghostty_mouse_event_set_mods(event, mods);
  ghostty_mouse_event_set_position(event, (GhosttyMousePosition){.x = x, .y = y});
  size_t required = 0;
  GhosttyResult result = ghostty_mouse_encoder_encode(engine->mouse_encoder, event,
                                                       NULL, 0, &required);
  if (result != GHOSTTY_OUT_OF_SPACE && result != GHOSTTY_SUCCESS) goto fail;
  output->data = required == 0 ? NULL : malloc(required);
  if (required != 0 && output->data == NULL) goto fail;
  if (ghostty_mouse_encoder_encode(engine->mouse_encoder, event,
                                   (char *)output->data, required,
                                   &output->len) != GHOSTTY_SUCCESS)
    goto fail;
  ghostty_mouse_event_free(event);
  return 1;
fail:
  ghostty_mouse_event_free(event);
  native_bytes_free(output);
  return 0;
}

void native_bytes_free(NativeBytes *output) {
  if (output == NULL) return;
  free(output->data);
  memset(output, 0, sizeof(*output));
}

static int append_bytes(uint8_t **data, size_t *len, size_t *cap,
                        const uint8_t *src, size_t src_len) {
  if (src_len > SIZE_MAX - *len) return 0;
  const size_t needed = *len + src_len;
  if (needed > *cap) {
    size_t next = *cap == 0 ? 256 : *cap;
    while (next < needed) {
      if (next > SIZE_MAX / 2) return 0;
      next *= 2;
    }
    uint8_t *grown = realloc(*data, next);
    if (grown == NULL) return 0;
    *data = grown;
    *cap = next;
  }
  if (src != NULL) memcpy(*data + *len, src, src_len);
  *len = needed;
  return 1;
}

static void copy_color(GhosttyStyleColor source, int *kind, uint8_t *r,
                       uint8_t *g, uint8_t *b, uint8_t *index) {
  *kind = source.tag;
  if (source.tag == GHOSTTY_STYLE_COLOR_PALETTE) {
    *index = source.value.palette;
  } else if (source.tag == GHOSTTY_STYLE_COLOR_RGB) {
    *r = source.value.rgb.r;
    *g = source.value.rgb.g;
    *b = source.value.rgb.b;
  }
}

static int capture_graphics(NativeEngine *engine, NativeFrame *frame) {
  GhosttyKittyGraphics graphics = NULL;
  GhosttyResult result = ghostty_terminal_get(
      engine->terminal, GHOSTTY_TERMINAL_DATA_KITTY_GRAPHICS, &graphics);
  if (result != GHOSTTY_SUCCESS || graphics == NULL) return 0;
  if (ghostty_kitty_graphics_get(graphics,
                                GHOSTTY_KITTY_GRAPHICS_DATA_GENERATION,
                                &frame->graphics_generation) != GHOSTTY_SUCCESS)
    return 0;
  if (frame->graphics_generation == 0) return 1;

  GhosttyKittyGraphicsPlacementIterator iterator = NULL;
  if (ghostty_kitty_graphics_placement_iterator_new(NULL, &iterator) !=
          GHOSTTY_SUCCESS ||
      ghostty_kitty_graphics_get(
          graphics, GHOSTTY_KITTY_GRAPHICS_DATA_PLACEMENT_ITERATOR,
          &iterator) != GHOSTTY_SUCCESS) {
    ghostty_kitty_graphics_placement_iterator_free(iterator);
    return 0;
  }
  while (ghostty_kitty_graphics_placement_next(iterator)) {
    NativePlacement placement = {0};
    GhosttyKittyGraphicsPlacementData keys[] = {
        GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_IMAGE_ID,
        GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_PLACEMENT_ID,
        GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_IS_VIRTUAL,
        GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_Z,
    };
    void *values[] = {&placement.image_id, &placement.placement_id,
                      &placement.is_virtual, &placement.z};
    if (ghostty_kitty_graphics_placement_get_multi(
            iterator, 4, keys, values, NULL) != GHOSTTY_SUCCESS)
      goto fail;
    GhosttyKittyGraphicsImage image =
        ghostty_kitty_graphics_image(graphics, placement.image_id);
    if (image == NULL) goto fail;
    GhosttyKittyGraphicsPlacementRenderInfo info =
        GHOSTTY_INIT_SIZED(GhosttyKittyGraphicsPlacementRenderInfo);
    if (ghostty_kitty_graphics_placement_render_info(
            iterator, image, engine->terminal, &info) != GHOSTTY_SUCCESS)
      goto fail;
    placement.viewport_col = info.viewport_col;
    placement.viewport_row = info.viewport_row;
    placement.grid_cols = info.grid_cols;
    placement.grid_rows = info.grid_rows;
    placement.visible = info.viewport_visible;

    NativePlacement *placements = realloc(
        frame->placements, (frame->placements_len + 1) * sizeof(*placements));
    if (placements == NULL) goto fail;
    frame->placements = placements;
    frame->placements[frame->placements_len++] = placement;

    size_t image_index = 0;
    while (image_index < frame->images_len &&
           frame->images[image_index].id != placement.image_id)
      image_index++;
    if (image_index != frame->images_len) continue;
    NativeImage captured = {.id = placement.image_id};
    const uint8_t *pixels = NULL;
    GhosttyKittyGraphicsImageData image_keys[] = {
        GHOSTTY_KITTY_IMAGE_DATA_WIDTH,
        GHOSTTY_KITTY_IMAGE_DATA_HEIGHT,
        GHOSTTY_KITTY_IMAGE_DATA_FORMAT,
        GHOSTTY_KITTY_IMAGE_DATA_GENERATION,
        GHOSTTY_KITTY_IMAGE_DATA_DATA_PTR,
        GHOSTTY_KITTY_IMAGE_DATA_DATA_LEN,
    };
    void *image_values[] = {&captured.width, &captured.height, &captured.format,
                            &captured.generation, &pixels, &captured.pixels_len};
    if (ghostty_kitty_graphics_image_get_multi(
            image, 6, image_keys, image_values, NULL) != GHOSTTY_SUCCESS ||
        (captured.pixels_len != 0 && pixels == NULL))
      goto fail;
    if (captured.pixels_len != 0) {
      captured.pixels = malloc(captured.pixels_len);
      if (captured.pixels == NULL) goto fail;
      memcpy(captured.pixels, pixels, captured.pixels_len);
    }
    NativeImage *images =
        realloc(frame->images, (frame->images_len + 1) * sizeof(*images));
    if (images == NULL) {
      free(captured.pixels);
      goto fail;
    }
    frame->images = images;
    frame->images[frame->images_len++] = captured;
  }
  ghostty_kitty_graphics_placement_iterator_free(iterator);
  return 1;

fail:
  ghostty_kitty_graphics_placement_iterator_free(iterator);
  return 0;
}

int native_capture_frame(NativeEngine *engine, NativeFrame *frame) {
  if (engine == NULL || frame == NULL) return 0;
  memset(frame, 0, sizeof(*frame));
  if (ghostty_render_state_update(engine->render, engine->terminal) != GHOSTTY_SUCCESS)
    return 0;
  if (ghostty_render_state_get(engine->render, GHOSTTY_RENDER_STATE_DATA_COLS,
                              &frame->width) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(engine->render, GHOSTTY_RENDER_STATE_DATA_ROWS,
                              &frame->height) != GHOSTTY_SUCCESS)
    return 0;
  bool cursor_has_value = false;
  if (ghostty_render_state_get(engine->render,
                              GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE,
                              &frame->cursor_visible) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(engine->render,
                              GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
                              &cursor_has_value) != GHOSTTY_SUCCESS)
    return 0;
  if (cursor_has_value &&
      (ghostty_render_state_get(engine->render,
                               GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X,
                               &frame->cursor_x) != GHOSTTY_SUCCESS ||
       ghostty_render_state_get(engine->render,
                               GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y,
                               &frame->cursor_y) != GHOSTTY_SUCCESS))
    return 0;
  GhosttyTerminalScreen active_screen;
  GhosttyTerminalModeConfig origin = {.mode = GHOSTTY_MODE_ORIGIN};
  GhosttyTerminalModeConfig bracketed = {.mode = GHOSTTY_MODE_BRACKETED_PASTE};
  if (ghostty_terminal_get(engine->terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN,
                          &active_screen) != GHOSTTY_SUCCESS ||
      ghostty_terminal_get(engine->terminal, GHOSTTY_TERMINAL_DATA_MODE,
                          &origin) != GHOSTTY_SUCCESS ||
      ghostty_terminal_get(engine->terminal, GHOSTTY_TERMINAL_DATA_MODE,
                          &bracketed) != GHOSTTY_SUCCESS)
    return 0;
  frame->active_screen = active_screen;
  frame->mode_origin = origin.value;
  frame->mode_bracketed_paste = bracketed.value;

  frame->row_offsets = calloc((size_t)frame->height + 1, sizeof(size_t));
  if (frame->width != 0 && frame->height > SIZE_MAX / frame->width) return 0;
  frame->cells = calloc((size_t)frame->width * frame->height, sizeof(NativeCell));
  if (frame->row_offsets == NULL || frame->cells == NULL) goto fail;
  GhosttyRenderStateRowIterator rows = NULL;
  GhosttyRenderStateRowCells cells = NULL;
  if (ghostty_render_state_row_iterator_new(NULL, &rows) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(NULL, &cells) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(engine->render, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                               &rows) != GHOSTTY_SUCCESS)
    goto fail;

  size_t cap = 0;
  uint16_t row = 0;
  while (row < frame->height && ghostty_render_state_row_iterator_next(rows)) {
    frame->row_offsets[row] = frame->data_len;
    if (ghostty_render_state_row_get(rows, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                                    &cells) != GHOSTTY_SUCCESS)
      goto fail;
    uint16_t column = 0;
    while (column < frame->width && ghostty_render_state_row_cells_next(cells)) {
      NativeCell *out = &frame->cells[(size_t)row * frame->width + column];
      GhosttyCell raw = 0;
      GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
      if (ghostty_render_state_row_cells_get(
              cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw) != GHOSTTY_SUCCESS ||
          ghostty_render_state_row_cells_get(
              cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style) != GHOSTTY_SUCCESS ||
          ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &out->width) != GHOSTTY_SUCCESS)
        goto fail;
      copy_color(style.fg_color, &out->foreground_kind, &out->foreground_r,
                 &out->foreground_g, &out->foreground_b, &out->foreground_index);
      copy_color(style.bg_color, &out->background_kind, &out->background_r,
                 &out->background_g, &out->background_b, &out->background_index);
      out->underline = style.underline;
      out->bold = style.bold;
      out->italic = style.italic;
      out->faint = style.faint;
      out->blink = style.blink;
      out->inverse = style.inverse;
      out->invisible = style.invisible;
      out->strikethrough = style.strikethrough;
      out->overline = style.overline;

      bool has_hyperlink = false;
      if (ghostty_cell_get(raw, GHOSTTY_CELL_DATA_HAS_HYPERLINK,
                           &has_hyperlink) != GHOSTTY_SUCCESS)
        goto fail;
      if (has_hyperlink) {
        GhosttyPoint point = {
            .tag = GHOSTTY_POINT_TAG_VIEWPORT,
            .value = {.coordinate = {.x = column, .y = row}},
        };
        GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
        size_t uri_len = 0;
        if (ghostty_terminal_grid_ref(engine->terminal, point, &ref) != GHOSTTY_SUCCESS)
          goto fail;
        GhosttyResult uri_result =
            ghostty_grid_ref_hyperlink_uri(&ref, NULL, 0, &uri_len);
        if (uri_result != GHOSTTY_OUT_OF_SPACE && uri_result != GHOSTTY_SUCCESS)
          goto fail;
        out->hyperlink_offset = frame->data_len;
        if (uri_len != 0) {
          const size_t old_len = frame->data_len;
          if (!append_bytes(&frame->data, &frame->data_len, &cap, NULL, uri_len))
            goto fail;
          if (ghostty_grid_ref_hyperlink_uri(&ref, frame->data + old_len,
                                             uri_len, &out->hyperlink_len) !=
              GHOSTTY_SUCCESS)
            goto fail;
        }
      }

      GhosttyBuffer query = {0};
      GhosttyResult result = ghostty_render_state_row_cells_get(
          cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &query);
      if (result != GHOSTTY_SUCCESS && result != GHOSTTY_OUT_OF_SPACE) goto fail;
      out->text_offset = frame->data_len;
      if (query.len != 0) {
        if (query.len > SIZE_MAX - frame->data_len) goto fail;
        const size_t old_len = frame->data_len;
        if (!append_bytes(&frame->data, &frame->data_len, &cap, NULL, query.len))
          goto fail;
        GhosttyBuffer target = {.ptr = frame->data + old_len, .cap = query.len};
        if (ghostty_render_state_row_cells_get(
                cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8,
                &target) != GHOSTTY_SUCCESS)
          goto fail;
        out->text_len = target.len;
      }
      column++;
    }
    if (column != frame->width) goto fail;
    row++;
  }
  frame->row_offsets[frame->height] = frame->data_len;
  if (!capture_graphics(engine, frame)) goto fail;
  ghostty_render_state_row_cells_free(cells);
  ghostty_render_state_row_iterator_free(rows);
  return row == frame->height;

fail:
  ghostty_render_state_row_cells_free(cells);
  ghostty_render_state_row_iterator_free(rows);
  native_frame_free(frame);
  return 0;
}

void native_frame_free(NativeFrame *frame) {
  if (frame == NULL) return;
  free(frame->data);
  free(frame->row_offsets);
  free(frame->cells);
  for (size_t i = 0; i < frame->images_len; i++) free(frame->images[i].pixels);
  free(frame->images);
  free(frame->placements);
  memset(frame, 0, sizeof(*frame));
}

NativeAnchor *native_track_screen_cell(NativeEngine *engine, uint16_t x, uint32_t y) {
  if (engine == NULL) return NULL;
  NativeAnchor *anchor = calloc(1, sizeof(*anchor));
  if (anchor == NULL) return NULL;
  GhosttyPoint point = {
      .tag = GHOSTTY_POINT_TAG_SCREEN,
      .value = {.coordinate = {.x = x, .y = y}},
  };
  if (ghostty_terminal_grid_ref_track(engine->terminal, point, &anchor->ref) !=
      GHOSTTY_SUCCESS) {
    native_anchor_free(anchor);
    return NULL;
  }
  return anchor;
}

void native_anchor_free(NativeAnchor *anchor) {
  if (anchor == NULL) return;
  ghostty_tracked_grid_ref_free(anchor->ref);
  free(anchor);
}

int native_viewport_active(NativeEngine *engine, uint8_t *active) {
  if (engine == NULL || active == NULL) return 0;
  bool value = false;
  if (ghostty_terminal_get(engine->terminal, GHOSTTY_TERMINAL_DATA_VIEWPORT_ACTIVE,
                          &value) != GHOSTTY_SUCCESS)
    return 0;
  *active = value;
  return 1;
}

int native_read_history(NativeEngine *engine, NativeAnchor *anchor, uint16_t limit,
                        NativeFrame *page) {
  if (engine == NULL || anchor == NULL || page == NULL || limit == 0) return 0;
  memset(page, 0, sizeof(*page));
  GhosttyPointCoordinate start = {0};
  GhosttyResult anchor_result = ghostty_tracked_grid_ref_point(
      anchor->ref, GHOSTTY_POINT_TAG_SCREEN, &start);
  if (anchor_result == GHOSTTY_NO_VALUE) return 2;
  if (anchor_result != GHOSTTY_SUCCESS) return 0;
  uint16_t cols = 0;
  size_t total_rows = 0;
  if (ghostty_terminal_get(engine->terminal, GHOSTTY_TERMINAL_DATA_COLS, &cols) !=
          GHOSTTY_SUCCESS ||
      ghostty_terminal_get(engine->terminal, GHOSTTY_TERMINAL_DATA_TOTAL_ROWS,
                           &total_rows) != GHOSTTY_SUCCESS)
    return 0;
  size_t available = total_rows > start.y ? total_rows - start.y : 0;
  page->width = cols;
  page->height = available < limit ? (uint16_t)available : limit;
  page->row_offsets = calloc((size_t)page->height + 1, sizeof(size_t));
  if (page->width != 0 && page->height > SIZE_MAX / page->width) return 0;
  page->cells = calloc((size_t)page->width * page->height, sizeof(NativeCell));
  if (page->row_offsets == NULL || page->cells == NULL) goto fail;
  size_t cap = 0;
  for (uint16_t row = 0; row < page->height; row++) {
    page->row_offsets[row] = page->data_len;
    for (uint16_t column = 0; column < cols; column++) {
      GhosttyPoint point = {
          .tag = GHOSTTY_POINT_TAG_SCREEN,
          .value = {.coordinate = {.x = column, .y = start.y + row}},
      };
      GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
      if (ghostty_terminal_grid_ref(engine->terminal, point, &ref) != GHOSTTY_SUCCESS)
        goto fail;
      NativeCell *out = &page->cells[(size_t)row * cols + column];
      GhosttyCell raw = 0;
      GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
      if (ghostty_grid_ref_cell(&ref, &raw) != GHOSTTY_SUCCESS ||
          ghostty_grid_ref_style(&ref, &style) != GHOSTTY_SUCCESS ||
          ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &out->width) !=
              GHOSTTY_SUCCESS)
        goto fail;
      copy_color(style.fg_color, &out->foreground_kind, &out->foreground_r,
                 &out->foreground_g, &out->foreground_b,
                 &out->foreground_index);
      copy_color(style.bg_color, &out->background_kind, &out->background_r,
                 &out->background_g, &out->background_b,
                 &out->background_index);
      out->underline = style.underline;
      out->bold = style.bold;
      out->italic = style.italic;
      out->faint = style.faint;
      out->blink = style.blink;
      out->inverse = style.inverse;
      out->invisible = style.invisible;
      out->strikethrough = style.strikethrough;
      out->overline = style.overline;
      size_t uri_len = 0;
      GhosttyResult uri_result =
          ghostty_grid_ref_hyperlink_uri(&ref, NULL, 0, &uri_len);
      if (uri_result != GHOSTTY_SUCCESS && uri_result != GHOSTTY_OUT_OF_SPACE)
        goto fail;
      out->hyperlink_offset = page->data_len;
      if (uri_len != 0) {
        const size_t old_len = page->data_len;
        if (!append_bytes(&page->data, &page->data_len, &cap, NULL, uri_len))
          goto fail;
        if (ghostty_grid_ref_hyperlink_uri(&ref, page->data + old_len, uri_len,
                                           &out->hyperlink_len) != GHOSTTY_SUCCESS)
          goto fail;
      }
      size_t codepoint_len = 0;
      GhosttyResult result = ghostty_grid_ref_graphemes(&ref, NULL, 0, &codepoint_len);
      if (result != GHOSTTY_SUCCESS && result != GHOSTTY_OUT_OF_SPACE) goto fail;
      if (codepoint_len == 0) {
        const uint8_t blank = ' ';
        out->text_offset = page->data_len;
        if (!append_bytes(&page->data, &page->data_len, &cap, &blank, 1)) goto fail;
        out->text_len = 1;
        continue;
      }
      uint32_t *codepoints = calloc(codepoint_len, sizeof(uint32_t));
      if (codepoints == NULL) goto fail;
      result = ghostty_grid_ref_graphemes(&ref, codepoints, codepoint_len, &codepoint_len);
      if (result != GHOSTTY_SUCCESS) {
        free(codepoints);
        goto fail;
      }
      out->text_offset = page->data_len;
      for (size_t i = 0; i < codepoint_len; i++) {
        uint8_t utf8[4];
        size_t utf8_len = 0;
        uint32_t cp = codepoints[i];
        if (cp <= 0x7f) utf8[utf8_len++] = (uint8_t)cp;
        else if (cp <= 0x7ff) {
          utf8[utf8_len++] = 0xc0 | (uint8_t)(cp >> 6);
          utf8[utf8_len++] = 0x80 | (uint8_t)(cp & 0x3f);
        } else if (cp <= 0xffff) {
          utf8[utf8_len++] = 0xe0 | (uint8_t)(cp >> 12);
          utf8[utf8_len++] = 0x80 | (uint8_t)((cp >> 6) & 0x3f);
          utf8[utf8_len++] = 0x80 | (uint8_t)(cp & 0x3f);
        } else {
          utf8[utf8_len++] = 0xf0 | (uint8_t)(cp >> 18);
          utf8[utf8_len++] = 0x80 | (uint8_t)((cp >> 12) & 0x3f);
          utf8[utf8_len++] = 0x80 | (uint8_t)((cp >> 6) & 0x3f);
          utf8[utf8_len++] = 0x80 | (uint8_t)(cp & 0x3f);
        }
        if (!append_bytes(&page->data, &page->data_len, &cap, utf8, utf8_len)) {
          free(codepoints);
          goto fail;
        }
      }
      out->text_len = page->data_len - out->text_offset;
      free(codepoints);
    }
  }
  page->row_offsets[page->height] = page->data_len;
  return 1;

fail:
  native_frame_free(page);
  return 0;
}

void native_test_fatal(void) { abort(); }
