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

static int floeterm_key_from_w3c_code(const uint8_t *code, size_t code_len,
                                      GhosttyKey *key) {
  if (code == NULL || code_len == 0 || key == NULL) return 0;
#define FLOETERM_KEY(value, mapped)                                            \
  if (code_len == sizeof(value) - 1 &&                                        \
      memcmp(code, value, sizeof(value) - 1) == 0) {                          \
    *key = mapped;                                                             \
    return 1;                                                                  \
  }
  FLOETERM_KEY("Backquote", GHOSTTY_KEY_BACKQUOTE)
  FLOETERM_KEY("Backslash", GHOSTTY_KEY_BACKSLASH)
  FLOETERM_KEY("BracketLeft", GHOSTTY_KEY_BRACKET_LEFT)
  FLOETERM_KEY("BracketRight", GHOSTTY_KEY_BRACKET_RIGHT)
  FLOETERM_KEY("Comma", GHOSTTY_KEY_COMMA)
  FLOETERM_KEY("Digit0", GHOSTTY_KEY_DIGIT_0)
  FLOETERM_KEY("Digit1", GHOSTTY_KEY_DIGIT_1)
  FLOETERM_KEY("Digit2", GHOSTTY_KEY_DIGIT_2)
  FLOETERM_KEY("Digit3", GHOSTTY_KEY_DIGIT_3)
  FLOETERM_KEY("Digit4", GHOSTTY_KEY_DIGIT_4)
  FLOETERM_KEY("Digit5", GHOSTTY_KEY_DIGIT_5)
  FLOETERM_KEY("Digit6", GHOSTTY_KEY_DIGIT_6)
  FLOETERM_KEY("Digit7", GHOSTTY_KEY_DIGIT_7)
  FLOETERM_KEY("Digit8", GHOSTTY_KEY_DIGIT_8)
  FLOETERM_KEY("Digit9", GHOSTTY_KEY_DIGIT_9)
  FLOETERM_KEY("Equal", GHOSTTY_KEY_EQUAL)
  FLOETERM_KEY("IntlBackslash", GHOSTTY_KEY_INTL_BACKSLASH)
  FLOETERM_KEY("IntlRo", GHOSTTY_KEY_INTL_RO)
  FLOETERM_KEY("IntlYen", GHOSTTY_KEY_INTL_YEN)
  FLOETERM_KEY("KeyA", GHOSTTY_KEY_A)
  FLOETERM_KEY("KeyB", GHOSTTY_KEY_B)
  FLOETERM_KEY("KeyC", GHOSTTY_KEY_C)
  FLOETERM_KEY("KeyD", GHOSTTY_KEY_D)
  FLOETERM_KEY("KeyE", GHOSTTY_KEY_E)
  FLOETERM_KEY("KeyF", GHOSTTY_KEY_F)
  FLOETERM_KEY("KeyG", GHOSTTY_KEY_G)
  FLOETERM_KEY("KeyH", GHOSTTY_KEY_H)
  FLOETERM_KEY("KeyI", GHOSTTY_KEY_I)
  FLOETERM_KEY("KeyJ", GHOSTTY_KEY_J)
  FLOETERM_KEY("KeyK", GHOSTTY_KEY_K)
  FLOETERM_KEY("KeyL", GHOSTTY_KEY_L)
  FLOETERM_KEY("KeyM", GHOSTTY_KEY_M)
  FLOETERM_KEY("KeyN", GHOSTTY_KEY_N)
  FLOETERM_KEY("KeyO", GHOSTTY_KEY_O)
  FLOETERM_KEY("KeyP", GHOSTTY_KEY_P)
  FLOETERM_KEY("KeyQ", GHOSTTY_KEY_Q)
  FLOETERM_KEY("KeyR", GHOSTTY_KEY_R)
  FLOETERM_KEY("KeyS", GHOSTTY_KEY_S)
  FLOETERM_KEY("KeyT", GHOSTTY_KEY_T)
  FLOETERM_KEY("KeyU", GHOSTTY_KEY_U)
  FLOETERM_KEY("KeyV", GHOSTTY_KEY_V)
  FLOETERM_KEY("KeyW", GHOSTTY_KEY_W)
  FLOETERM_KEY("KeyX", GHOSTTY_KEY_X)
  FLOETERM_KEY("KeyY", GHOSTTY_KEY_Y)
  FLOETERM_KEY("KeyZ", GHOSTTY_KEY_Z)
  FLOETERM_KEY("Minus", GHOSTTY_KEY_MINUS)
  FLOETERM_KEY("Period", GHOSTTY_KEY_PERIOD)
  FLOETERM_KEY("Quote", GHOSTTY_KEY_QUOTE)
  FLOETERM_KEY("Semicolon", GHOSTTY_KEY_SEMICOLON)
  FLOETERM_KEY("Slash", GHOSTTY_KEY_SLASH)
  FLOETERM_KEY("AltLeft", GHOSTTY_KEY_ALT_LEFT)
  FLOETERM_KEY("AltRight", GHOSTTY_KEY_ALT_RIGHT)
  FLOETERM_KEY("Backspace", GHOSTTY_KEY_BACKSPACE)
  FLOETERM_KEY("CapsLock", GHOSTTY_KEY_CAPS_LOCK)
  FLOETERM_KEY("ContextMenu", GHOSTTY_KEY_CONTEXT_MENU)
  FLOETERM_KEY("ControlLeft", GHOSTTY_KEY_CONTROL_LEFT)
  FLOETERM_KEY("ControlRight", GHOSTTY_KEY_CONTROL_RIGHT)
  FLOETERM_KEY("Enter", GHOSTTY_KEY_ENTER)
  FLOETERM_KEY("MetaLeft", GHOSTTY_KEY_META_LEFT)
  FLOETERM_KEY("MetaRight", GHOSTTY_KEY_META_RIGHT)
  FLOETERM_KEY("ShiftLeft", GHOSTTY_KEY_SHIFT_LEFT)
  FLOETERM_KEY("ShiftRight", GHOSTTY_KEY_SHIFT_RIGHT)
  FLOETERM_KEY("Space", GHOSTTY_KEY_SPACE)
  FLOETERM_KEY("Tab", GHOSTTY_KEY_TAB)
  FLOETERM_KEY("Convert", GHOSTTY_KEY_CONVERT)
  FLOETERM_KEY("KanaMode", GHOSTTY_KEY_KANA_MODE)
  FLOETERM_KEY("NonConvert", GHOSTTY_KEY_NON_CONVERT)
  FLOETERM_KEY("Delete", GHOSTTY_KEY_DELETE)
  FLOETERM_KEY("End", GHOSTTY_KEY_END)
  FLOETERM_KEY("Help", GHOSTTY_KEY_HELP)
  FLOETERM_KEY("Home", GHOSTTY_KEY_HOME)
  FLOETERM_KEY("Insert", GHOSTTY_KEY_INSERT)
  FLOETERM_KEY("PageDown", GHOSTTY_KEY_PAGE_DOWN)
  FLOETERM_KEY("PageUp", GHOSTTY_KEY_PAGE_UP)
  FLOETERM_KEY("ArrowDown", GHOSTTY_KEY_ARROW_DOWN)
  FLOETERM_KEY("ArrowLeft", GHOSTTY_KEY_ARROW_LEFT)
  FLOETERM_KEY("ArrowRight", GHOSTTY_KEY_ARROW_RIGHT)
  FLOETERM_KEY("ArrowUp", GHOSTTY_KEY_ARROW_UP)
  FLOETERM_KEY("NumLock", GHOSTTY_KEY_NUM_LOCK)
  FLOETERM_KEY("Numpad0", GHOSTTY_KEY_NUMPAD_0)
  FLOETERM_KEY("Numpad1", GHOSTTY_KEY_NUMPAD_1)
  FLOETERM_KEY("Numpad2", GHOSTTY_KEY_NUMPAD_2)
  FLOETERM_KEY("Numpad3", GHOSTTY_KEY_NUMPAD_3)
  FLOETERM_KEY("Numpad4", GHOSTTY_KEY_NUMPAD_4)
  FLOETERM_KEY("Numpad5", GHOSTTY_KEY_NUMPAD_5)
  FLOETERM_KEY("Numpad6", GHOSTTY_KEY_NUMPAD_6)
  FLOETERM_KEY("Numpad7", GHOSTTY_KEY_NUMPAD_7)
  FLOETERM_KEY("Numpad8", GHOSTTY_KEY_NUMPAD_8)
  FLOETERM_KEY("Numpad9", GHOSTTY_KEY_NUMPAD_9)
  FLOETERM_KEY("NumpadAdd", GHOSTTY_KEY_NUMPAD_ADD)
  FLOETERM_KEY("NumpadBackspace", GHOSTTY_KEY_NUMPAD_BACKSPACE)
  FLOETERM_KEY("NumpadClear", GHOSTTY_KEY_NUMPAD_CLEAR)
  FLOETERM_KEY("NumpadClearEntry", GHOSTTY_KEY_NUMPAD_CLEAR_ENTRY)
  FLOETERM_KEY("NumpadComma", GHOSTTY_KEY_NUMPAD_COMMA)
  FLOETERM_KEY("NumpadDecimal", GHOSTTY_KEY_NUMPAD_DECIMAL)
  FLOETERM_KEY("NumpadDivide", GHOSTTY_KEY_NUMPAD_DIVIDE)
  FLOETERM_KEY("NumpadEnter", GHOSTTY_KEY_NUMPAD_ENTER)
  FLOETERM_KEY("NumpadEqual", GHOSTTY_KEY_NUMPAD_EQUAL)
  FLOETERM_KEY("NumpadMemoryAdd", GHOSTTY_KEY_NUMPAD_MEMORY_ADD)
  FLOETERM_KEY("NumpadMemoryClear", GHOSTTY_KEY_NUMPAD_MEMORY_CLEAR)
  FLOETERM_KEY("NumpadMemoryRecall", GHOSTTY_KEY_NUMPAD_MEMORY_RECALL)
  FLOETERM_KEY("NumpadMemoryStore", GHOSTTY_KEY_NUMPAD_MEMORY_STORE)
  FLOETERM_KEY("NumpadMemorySubtract", GHOSTTY_KEY_NUMPAD_MEMORY_SUBTRACT)
  FLOETERM_KEY("NumpadMultiply", GHOSTTY_KEY_NUMPAD_MULTIPLY)
  FLOETERM_KEY("NumpadParenLeft", GHOSTTY_KEY_NUMPAD_PAREN_LEFT)
  FLOETERM_KEY("NumpadParenRight", GHOSTTY_KEY_NUMPAD_PAREN_RIGHT)
  FLOETERM_KEY("NumpadSubtract", GHOSTTY_KEY_NUMPAD_SUBTRACT)
  FLOETERM_KEY("NumpadSeparator", GHOSTTY_KEY_NUMPAD_SEPARATOR)
  FLOETERM_KEY("NumpadUp", GHOSTTY_KEY_NUMPAD_UP)
  FLOETERM_KEY("NumpadDown", GHOSTTY_KEY_NUMPAD_DOWN)
  FLOETERM_KEY("NumpadRight", GHOSTTY_KEY_NUMPAD_RIGHT)
  FLOETERM_KEY("NumpadLeft", GHOSTTY_KEY_NUMPAD_LEFT)
  FLOETERM_KEY("NumpadBegin", GHOSTTY_KEY_NUMPAD_BEGIN)
  FLOETERM_KEY("NumpadHome", GHOSTTY_KEY_NUMPAD_HOME)
  FLOETERM_KEY("NumpadEnd", GHOSTTY_KEY_NUMPAD_END)
  FLOETERM_KEY("NumpadInsert", GHOSTTY_KEY_NUMPAD_INSERT)
  FLOETERM_KEY("NumpadDelete", GHOSTTY_KEY_NUMPAD_DELETE)
  FLOETERM_KEY("NumpadPageUp", GHOSTTY_KEY_NUMPAD_PAGE_UP)
  FLOETERM_KEY("NumpadPageDown", GHOSTTY_KEY_NUMPAD_PAGE_DOWN)
  FLOETERM_KEY("Escape", GHOSTTY_KEY_ESCAPE)
  FLOETERM_KEY("F1", GHOSTTY_KEY_F1)
  FLOETERM_KEY("F2", GHOSTTY_KEY_F2)
  FLOETERM_KEY("F3", GHOSTTY_KEY_F3)
  FLOETERM_KEY("F4", GHOSTTY_KEY_F4)
  FLOETERM_KEY("F5", GHOSTTY_KEY_F5)
  FLOETERM_KEY("F6", GHOSTTY_KEY_F6)
  FLOETERM_KEY("F7", GHOSTTY_KEY_F7)
  FLOETERM_KEY("F8", GHOSTTY_KEY_F8)
  FLOETERM_KEY("F9", GHOSTTY_KEY_F9)
  FLOETERM_KEY("F10", GHOSTTY_KEY_F10)
  FLOETERM_KEY("F11", GHOSTTY_KEY_F11)
  FLOETERM_KEY("F12", GHOSTTY_KEY_F12)
  FLOETERM_KEY("F13", GHOSTTY_KEY_F13)
  FLOETERM_KEY("F14", GHOSTTY_KEY_F14)
  FLOETERM_KEY("F15", GHOSTTY_KEY_F15)
  FLOETERM_KEY("F16", GHOSTTY_KEY_F16)
  FLOETERM_KEY("F17", GHOSTTY_KEY_F17)
  FLOETERM_KEY("F18", GHOSTTY_KEY_F18)
  FLOETERM_KEY("F19", GHOSTTY_KEY_F19)
  FLOETERM_KEY("F20", GHOSTTY_KEY_F20)
  FLOETERM_KEY("F21", GHOSTTY_KEY_F21)
  FLOETERM_KEY("F22", GHOSTTY_KEY_F22)
  FLOETERM_KEY("F23", GHOSTTY_KEY_F23)
  FLOETERM_KEY("F24", GHOSTTY_KEY_F24)
  FLOETERM_KEY("F25", GHOSTTY_KEY_F25)
  FLOETERM_KEY("Fn", GHOSTTY_KEY_FN)
  FLOETERM_KEY("FnLock", GHOSTTY_KEY_FN_LOCK)
  FLOETERM_KEY("PrintScreen", GHOSTTY_KEY_PRINT_SCREEN)
  FLOETERM_KEY("ScrollLock", GHOSTTY_KEY_SCROLL_LOCK)
  FLOETERM_KEY("Pause", GHOSTTY_KEY_PAUSE)
  FLOETERM_KEY("BrowserBack", GHOSTTY_KEY_BROWSER_BACK)
  FLOETERM_KEY("BrowserFavorites", GHOSTTY_KEY_BROWSER_FAVORITES)
  FLOETERM_KEY("BrowserForward", GHOSTTY_KEY_BROWSER_FORWARD)
  FLOETERM_KEY("BrowserHome", GHOSTTY_KEY_BROWSER_HOME)
  FLOETERM_KEY("BrowserRefresh", GHOSTTY_KEY_BROWSER_REFRESH)
  FLOETERM_KEY("BrowserSearch", GHOSTTY_KEY_BROWSER_SEARCH)
  FLOETERM_KEY("BrowserStop", GHOSTTY_KEY_BROWSER_STOP)
  FLOETERM_KEY("Eject", GHOSTTY_KEY_EJECT)
  FLOETERM_KEY("LaunchApp1", GHOSTTY_KEY_LAUNCH_APP_1)
  FLOETERM_KEY("LaunchApp2", GHOSTTY_KEY_LAUNCH_APP_2)
  FLOETERM_KEY("LaunchMail", GHOSTTY_KEY_LAUNCH_MAIL)
  FLOETERM_KEY("MediaPlayPause", GHOSTTY_KEY_MEDIA_PLAY_PAUSE)
  FLOETERM_KEY("MediaSelect", GHOSTTY_KEY_MEDIA_SELECT)
  FLOETERM_KEY("MediaStop", GHOSTTY_KEY_MEDIA_STOP)
  FLOETERM_KEY("MediaTrackNext", GHOSTTY_KEY_MEDIA_TRACK_NEXT)
  FLOETERM_KEY("MediaTrackPrevious", GHOSTTY_KEY_MEDIA_TRACK_PREVIOUS)
  FLOETERM_KEY("Power", GHOSTTY_KEY_POWER)
  FLOETERM_KEY("Sleep", GHOSTTY_KEY_SLEEP)
  FLOETERM_KEY("AudioVolumeDown", GHOSTTY_KEY_AUDIO_VOLUME_DOWN)
  FLOETERM_KEY("AudioVolumeMute", GHOSTTY_KEY_AUDIO_VOLUME_MUTE)
  FLOETERM_KEY("AudioVolumeUp", GHOSTTY_KEY_AUDIO_VOLUME_UP)
  FLOETERM_KEY("WakeUp", GHOSTTY_KEY_WAKE_UP)
  FLOETERM_KEY("Copy", GHOSTTY_KEY_COPY)
  FLOETERM_KEY("Cut", GHOSTTY_KEY_CUT)
  FLOETERM_KEY("Paste", GHOSTTY_KEY_PASTE)
#undef FLOETERM_KEY
  return 0;
}

int floeterm_native_encode_key(NativeEngine *engine, const uint8_t *code,
                               size_t code_len, int action, uint16_t mods,
                               const uint8_t *text, size_t text_len,
                               NativeBytes *output) {
  if (engine == NULL || output == NULL || (text == NULL && text_len != 0))
    return 0;
  memset(output, 0, sizeof(*output));
  GhosttyKey mapped_key;
  if (!floeterm_key_from_w3c_code(code, code_len, &mapped_key)) return 0;
  GhosttyKeyAction mapped_action;
  switch (action) {
    case 1: mapped_action = GHOSTTY_KEY_ACTION_PRESS; break;
    case 2: mapped_action = GHOSTTY_KEY_ACTION_REPEAT; break;
    case 3: mapped_action = GHOSTTY_KEY_ACTION_RELEASE; break;
    default: return 0;
  }
  GhosttyKeyEvent event = NULL;
  if (ghostty_key_event_new(NULL, &event) != GHOSTTY_SUCCESS) return 0;
  ghostty_key_encoder_setopt_from_terminal(engine->key_encoder, engine->terminal);
  GhosttyOptionAsAlt option_as_alt = GHOSTTY_OPTION_AS_ALT_TRUE;
  ghostty_key_encoder_setopt(engine->key_encoder,
                             GHOSTTY_KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT,
                             &option_as_alt);
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
