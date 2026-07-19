export const nearestRankPercentile = (values, percentile) => {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(sorted.length * percentile));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
};

const check = (failures, condition, message) => {
  if (!condition) failures.push(message);
};

const isMetricGroup = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const checkNumber = (failures, value, missingMessage, predicate, violationMessage) => {
  if (!Number.isFinite(value)) {
    failures.push(missingMessage);
    return;
  }
  check(failures, predicate(value), violationMessage(value));
};

export const evaluateStandalonePerformanceReport = report => {
  const failures = [];
  check(
    failures,
    report?.runner?.browser_mode === 'headed_hardware_webgl2',
    'performance runner must use headed hardware WebGL2',
  );
  const gpuRenderer = typeof report?.runner?.gpu_renderer === 'string'
    ? report.runner.gpu_renderer.trim()
    : '';
  check(failures, gpuRenderer.length > 0, 'performance runner GPU renderer missing');
  if (gpuRenderer.length > 0) {
    check(
      failures,
      !/(swiftshader|software|llvmpipe)/i.test(gpuRenderer),
      'performance runner used a software GPU renderer',
    );
  }
  const metrics = report?.metrics;
  const key = metrics?.key_to_paint;
  const paste = metrics?.large_paste;
  const plain = metrics?.plain_output;
  const ansi = metrics?.ansi_unicode_output;
  const render = metrics?.render_frames;
  const sentinel = metrics?.ui_sentinel;
  const reconnect = metrics?.reconnect;
  const mirror = metrics?.mirror_same_session;
  const multiPageResize = metrics?.multi_page_resize;
  const mirrorFunctional = report?.functional?.mirror_same_session;
  const multiPageResizeFunctional = report?.functional?.multi_page_resize;

  if (!isMetricGroup(key)) {
    failures.push('key-to-paint metrics missing');
  } else {
    check(failures, key.sample_count === 100, 'key-to-paint requires exactly 100 samples');
    checkNumber(failures, key.p95_ms, 'key-to-paint p95 missing', value => value <= 25, value => `key-to-paint p95 ${value}ms exceeds 25ms`);
    checkNumber(failures, key.p99_ms, 'key-to-paint p99 missing', value => value <= 40, value => `key-to-paint p99 ${value}ms exceeds 40ms`);
  }

  if (!isMetricGroup(paste)) {
    failures.push('5 MiB large paste metrics missing');
  } else {
    const expectedPasteBytes = 5 * 1024 * 1024;
    checkNumber(failures, paste.input_bytes, 'large paste input bytes missing', value => value === expectedPasteBytes, value => `large paste input bytes ${value} does not equal ${expectedPasteBytes}`);
    checkNumber(failures, paste.received_bytes, 'large paste received bytes missing', value => value === expectedPasteBytes, value => `large paste received bytes ${value} does not equal ${expectedPasteBytes}`);
    check(failures, paste.checksum_match === true, 'large paste checksum differs after PTY delivery');
    check(failures, paste.paste_event_consumed === true, 'large paste did not use the terminal native paste path');
    checkNumber(failures, paste.dispatch_ms, 'large paste dispatch duration missing', value => value <= 50, value => `large paste dispatch ${value}ms exceeds 50ms`);
    checkNumber(failures, paste.completion_ms, 'large paste completion duration missing', value => value <= 2000, value => `large paste completion ${value}ms exceeds 2000ms`);
    checkNumber(failures, paste.websocket_messages, 'large paste WebSocket message count missing', value => value === 80, value => `large paste used ${value} WebSocket messages instead of 80`);
    checkNumber(failures, paste.wire_ratio, 'large paste wire ratio missing', value => value <= 1.01, value => `large paste wire ratio ${value} exceeds 1.01`);
    checkNumber(failures, paste.ui_sentinel_p95_ms, 'large paste UI sentinel p95 missing', value => value <= 50, value => `large paste UI sentinel p95 ${value}ms exceeds 50ms`);
    checkNumber(failures, paste.heap_delta_mib, 'large paste retained heap delta missing', value => value <= 20, value => `large paste retained heap delta ${value} MiB exceeds 20 MiB`);
    check(failures, paste.history_recovery_requests === 0, 'large paste triggered history recovery');
  }

  if (!isMetricGroup(plain)) {
    failures.push('10 MiB plain output metrics missing');
  } else {
    checkNumber(failures, plain.duration_ms, '10 MiB plain output duration missing', value => value <= 2500, value => `10 MiB plain output ${value}ms exceeds 2500ms`);
    checkNumber(failures, plain.websocket_messages, '10 MiB plain output WebSocket message count missing', value => value <= 700, value => `10 MiB plain output used ${value} WebSocket messages`);
    checkNumber(failures, plain.wire_ratio, '10 MiB plain output wire ratio missing', value => value <= 1.05, value => `10 MiB plain output wire ratio ${value} exceeds 1.05`);
    check(failures, plain.history_recovery_requests === 0, '10 MiB plain output triggered history recovery');
    check(failures, plain.sequence_gaps === 0, '10 MiB plain output observed a sequence gap');
    check(failures, plain.silent_drops === 0, '10 MiB plain output observed a silent drop');
  }

  if (!isMetricGroup(ansi)) {
    failures.push('5 MiB ANSI/Unicode output metrics missing');
  } else {
    checkNumber(failures, ansi.duration_ms, '5 MiB ANSI/Unicode output duration missing', value => value <= 3500, value => `5 MiB ANSI/Unicode output ${value}ms exceeds 3500ms`);
    check(failures, ansi.canvas_match === true, 'ANSI/Unicode final canvas differs from the repeated baseline');
    check(failures, ansi.terminal_state_match === true, 'ANSI/Unicode final terminal state differs from the repeated baseline');
  }

  const refreshPeriodMs = Number(report?.runner?.refresh_period_ms ?? 0);
  check(failures, refreshPeriodMs > 0, 'display refresh period was not measured');
  if (!isMetricGroup(render)) {
    failures.push('render frame metrics missing');
  } else if (refreshPeriodMs > 0) {
    checkNumber(failures, render.p95_ms, 'render p95 missing', value => value <= refreshPeriodMs + 2, value => `render p95 ${value}ms exceeds one refresh period + 2ms`);
    checkNumber(failures, render.p99_ms, 'render p99 missing', value => value <= refreshPeriodMs * 2 + 2, value => `render p99 ${value}ms exceeds two refresh periods + 2ms`);
    checkNumber(failures, render.max_ms, 'render max missing', value => value <= 100, value => `render max ${value}ms exceeds 100ms`);
  }
  if (!isMetricGroup(sentinel)) {
    failures.push('UI sentinel metrics missing');
  } else {
    checkNumber(failures, sentinel.p95_ms, 'UI sentinel p95 missing', value => value <= 50, value => `UI sentinel p95 ${value}ms exceeds 50ms`);
  }

  if (!isMetricGroup(reconnect)) {
    failures.push('reconnect metrics missing');
  } else {
    check(failures, reconnect.iterations === 20, 'reconnect leak check requires 20 iterations');
    checkNumber(failures, reconnect.goroutine_delta, 'goroutine delta missing', value => value === 0, value => `goroutine delta ${value} is not zero`);
    checkNumber(failures, reconnect.connection_delta, 'connection delta missing', value => value === 0, value => `connection delta ${value} is not zero`);
    checkNumber(failures, reconnect.live_attachment_delta, 'live attachment delta missing', value => value === 0, value => `live attachment delta ${value} is not zero`);
    checkNumber(failures, reconnect.heap_delta_mib, 'retained JS heap delta missing', value => value <= 20, value => `retained JS heap delta ${value} MiB exceeds 20 MiB`);
  }

  if (!isMetricGroup(mirror)) {
    failures.push('mirror same-session metrics missing');
  } else {
    check(failures, mirror.sample_count === 30, 'mirror same-session latency requires exactly 30 samples');
    checkNumber(failures, mirror.p95_ms, 'mirror same-session p95 missing', value => value <= 40, value => `mirror same-session p95 ${value}ms exceeds 40ms`);
    checkNumber(failures, mirror.p99_ms, 'mirror same-session p99 missing', value => value <= 60, value => `mirror same-session p99 ${value}ms exceeds 60ms`);
    checkNumber(failures, mirror.reconnect_ms, 'mirror same-session reconnect duration missing', value => value <= 1000, value => `mirror same-session reconnect ${value}ms exceeds 1000ms`);
  }

  if (!isMetricGroup(multiPageResize)) {
    failures.push('multi-page resize metrics missing');
  } else {
    check(failures, multiPageResize.sample_count === 40, 'multi-page resize requires exactly 40 samples');
    checkNumber(failures, multiPageResize.p95_ms, 'multi-page resize p95 missing', value => value <= 100, value => `multi-page resize p95 ${value}ms exceeds 100ms`);
    checkNumber(failures, multiPageResize.p99_ms, 'multi-page resize p99 missing', value => value <= 200, value => `multi-page resize p99 ${value}ms exceeds 200ms`);
    checkNumber(failures, multiPageResize.max_ms, 'multi-page resize max missing', value => value <= 250, value => `multi-page resize max ${value}ms exceeds 250ms`);
    checkNumber(failures, multiPageResize.output_bytes, 'multi-page resize output bytes missing', value => value > 0, value => `multi-page resize output bytes ${value} is not positive`);
    check(failures, multiPageResize.geometry_mismatches === 0, 'multi-page resize observed a geometry mismatch');
    check(failures, multiPageResize.sequence_gaps === 0, 'multi-page resize observed a sequence gap');
    check(failures, multiPageResize.history_recovery_requests === 0, 'multi-page resize triggered history recovery');
  }

  if (!isMetricGroup(mirrorFunctional)) {
    failures.push('mirror same-session functional checks missing');
  } else {
    check(failures, mirrorFunctional.connected_views === 2, 'mirror same-session did not connect exactly two views');
    check(failures, mirrorFunctional.distinct_view_dimensions === true, 'mirror same-session views did not retain distinct local dimensions');
    check(failures, mirrorFunctional.shared_pty_uses_minimum_dimensions === true, 'mirror shared PTY did not use the minimum live-view dimensions');
    check(failures, mirrorFunctional.identical_output_streams === true, 'mirror live views received different output sequences or bytes');
    check(failures, mirrorFunctional.identical_terminal_state === true, 'mirror live views rendered different terminal state');
    check(failures, mirrorFunctional.semantic_markers_visible_in_both === true, 'mirror semantic output markers were not visible in both views');
    check(failures, mirrorFunctional.first_input_visible_in_both === true, 'mirror first-view input was not visible in both views');
    check(failures, mirrorFunctional.reconnect_preserved_two_attachments === true, 'mirror reconnect did not preserve two live attachments');
    check(failures, mirrorFunctional.second_input_visible_in_both === true, 'mirror second-view input was not visible in both views');
    check(failures, mirrorFunctional.resize_preserved_connections === true, 'mirror resize disconnected a live view');
    check(failures, mirrorFunctional.renderer_error_count === 0, 'mirror same-session reported a renderer error');
  }
  if (!isMetricGroup(multiPageResizeFunctional)) {
    failures.push('multi-page resize functional checks missing');
  } else {
    check(failures, multiPageResizeFunctional.distinct_connection_ids === true, 'multi-page resize reused a page connection ID');
    check(failures, multiPageResizeFunctional.output_streams_match === true, 'multi-page resize live output streams differ');
    check(failures, multiPageResizeFunctional.terminal_state_match === true, 'multi-page resize terminal states differ');
    check(failures, multiPageResizeFunctional.detach_restored_remaining_view === true, 'multi-page resize did not restore the remaining view after detach');
    check(failures, multiPageResizeFunctional.external_session_preserved === true, 'multi-page resize deleted the externally managed session');
    check(failures, multiPageResizeFunctional.renderer_error_count === 0, 'multi-page resize reported a renderer error');
  }
  check(failures, Array.isArray(report?.errors) && report.errors.length === 0, 'browser/runtime errors were captured');

  return { status: failures.length === 0 ? 'passed' : 'failed', failures };
};
