import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateStandalonePerformanceReport,
  nearestRankPercentile,
} from '../performance/standalonePerformanceReport.mjs';

test('calculates nearest-rank percentiles', () => {
  assert.equal(nearestRankPercentile([5, 1, 3, 2, 4], 0.95), 5);
  assert.equal(nearestRankPercentile([1, 2, 3, 4, 5], 0.5), 3);
});

test('accepts a complete in-budget standalone report', () => {
  const report = {
    runner: {
      refresh_period_ms: 16.7,
      browser_mode: 'headed_hardware_webgl2',
      gpu_renderer: 'ANGLE Metal Renderer: Apple M3 Pro',
    },
    metrics: {
      key_to_paint: { sample_count: 100, p95_ms: 20, p99_ms: 30 },
      large_paste: {
        input_bytes: 5 * 1024 * 1024,
        received_bytes: 5 * 1024 * 1024,
        checksum_match: true,
        paste_event_consumed: true,
        dispatch_ms: 20,
        completion_ms: 1000,
        websocket_messages: 80,
        wire_ratio: 1.001,
        ui_sentinel_p95_ms: 40,
        heap_delta_mib: 10,
        history_recovery_requests: 0,
      },
      plain_output: {
        duration_ms: 2000,
        websocket_messages: 600,
        wire_ratio: 1.04,
        history_recovery_requests: 0,
        sequence_gaps: 0,
        silent_drops: 0,
      },
      ansi_unicode_output: { duration_ms: 3000, canvas_match: true, terminal_state_match: true },
      render_frames: { p95_ms: 17, p99_ms: 30, max_ms: 80 },
      ui_sentinel: { p95_ms: 40 },
      reconnect: {
        iterations: 20,
        goroutine_delta: 0,
        connection_delta: 0,
        live_attachment_delta: 0,
        heap_delta_mib: 10,
      },
      mirror_same_session: {
        sample_count: 30,
        p95_ms: 30,
        p99_ms: 45,
        reconnect_ms: 500,
      },
      multi_page_resize: {
        sample_count: 40,
        p95_ms: 60,
        p99_ms: 90,
        max_ms: 120,
        output_bytes: 1024 * 1024,
        geometry_mismatches: 0,
        sequence_gaps: 0,
        history_recovery_requests: 0,
      },
    },
    functional: {
      mirror_same_session: {
        connected_views: 2,
        distinct_view_dimensions: true,
        shared_pty_uses_minimum_dimensions: true,
        identical_output_streams: true,
        identical_terminal_state: true,
        semantic_markers_visible_in_both: true,
        first_input_visible_in_both: true,
        reconnect_preserved_two_attachments: true,
        second_input_visible_in_both: true,
        resize_preserved_connections: true,
        renderer_error_count: 0,
      },
      multi_page_resize: {
        distinct_connection_ids: true,
        output_streams_match: true,
        terminal_state_match: true,
        detach_restored_remaining_view: true,
        external_session_preserved: true,
        renderer_error_count: 0,
      },
    },
    errors: [],
  };
  assert.deepEqual(evaluateStandalonePerformanceReport(report), { status: 'passed', failures: [] });
});

test('reports each violated threshold', () => {
  const result = evaluateStandalonePerformanceReport({
    runner: {
      refresh_period_ms: 16,
      browser_mode: 'headless',
      gpu_renderer: 'ANGLE SwiftShader Device',
    },
    metrics: {
      key_to_paint: { sample_count: 99, p95_ms: 30, p99_ms: 50 },
      large_paste: {
        input_bytes: 5 * 1024 * 1024 - 1,
        received_bytes: 1,
        checksum_match: false,
        paste_event_consumed: false,
        dispatch_ms: 51,
        completion_ms: 2001,
        websocket_messages: 81,
        wire_ratio: 1.011,
        ui_sentinel_p95_ms: 51,
        heap_delta_mib: 21,
        history_recovery_requests: 1,
      },
      plain_output: {
        duration_ms: 3000,
        websocket_messages: 800,
        wire_ratio: 1.2,
        history_recovery_requests: 1,
        sequence_gaps: 1,
        silent_drops: 1,
      },
      ansi_unicode_output: { duration_ms: 4000, canvas_match: false, terminal_state_match: false },
      render_frames: { p95_ms: 30, p99_ms: 40, max_ms: 120 },
      ui_sentinel: { p95_ms: 60 },
      reconnect: {
        iterations: 19,
        goroutine_delta: 1,
        connection_delta: 1,
        live_attachment_delta: 1,
        heap_delta_mib: 21,
      },
      mirror_same_session: {
        sample_count: 29,
        p95_ms: 50,
        p99_ms: 70,
        reconnect_ms: 1500,
      },
      multi_page_resize: {
        sample_count: 39,
        p95_ms: 101,
        p99_ms: 201,
        max_ms: 251,
        output_bytes: 0,
        geometry_mismatches: 1,
        sequence_gaps: 1,
        history_recovery_requests: 1,
      },
    },
    functional: {
      mirror_same_session: {
        connected_views: 1,
        distinct_view_dimensions: false,
        shared_pty_uses_minimum_dimensions: false,
        identical_output_streams: false,
        identical_terminal_state: false,
        semantic_markers_visible_in_both: false,
        first_input_visible_in_both: false,
        reconnect_preserved_two_attachments: false,
        second_input_visible_in_both: false,
        resize_preserved_connections: false,
        renderer_error_count: 1,
      },
      multi_page_resize: {
        distinct_connection_ids: false,
        output_streams_match: false,
        terminal_state_match: false,
        detach_restored_remaining_view: false,
        external_session_preserved: false,
        renderer_error_count: 1,
      },
    },
    errors: ['renderer failed'],
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.failures.length >= 20);
});

test('reports missing metric groups without undefined threshold noise', () => {
  const result = evaluateStandalonePerformanceReport({
    runner: {},
    metrics: {},
    errors: ['runner stopped early'],
  });

  assert.equal(result.status, 'failed');
  assert.ok(result.failures.includes('key-to-paint metrics missing'));
  assert.ok(result.failures.includes('5 MiB large paste metrics missing'));
  assert.ok(result.failures.includes('10 MiB plain output metrics missing'));
  assert.ok(result.failures.includes('5 MiB ANSI/Unicode output metrics missing'));
  assert.ok(result.failures.includes('render frame metrics missing'));
  assert.ok(result.failures.includes('UI sentinel metrics missing'));
  assert.ok(result.failures.includes('reconnect metrics missing'));
  assert.ok(result.failures.includes('mirror same-session metrics missing'));
  assert.ok(result.failures.includes('multi-page resize metrics missing'));
  assert.ok(result.failures.includes('mirror same-session functional checks missing'));
  assert.ok(result.failures.includes('multi-page resize functional checks missing'));
  assert.equal(result.failures.some(failure => failure.includes('undefined')), false);
});

test('rejects software WebGL and non-headed browser measurements', () => {
  const report = {
    runner: {
      refresh_period_ms: 16.7,
      browser_mode: 'headless',
      gpu_renderer: 'ANGLE SwiftShader Device',
    },
    metrics: {
      key_to_paint: { sample_count: 100, p95_ms: 20, p99_ms: 30 },
      large_paste: {
        input_bytes: 5 * 1024 * 1024,
        received_bytes: 5 * 1024 * 1024,
        checksum_match: true,
        paste_event_consumed: true,
        dispatch_ms: 20,
        completion_ms: 1000,
        websocket_messages: 80,
        wire_ratio: 1.001,
        ui_sentinel_p95_ms: 40,
        heap_delta_mib: 10,
        history_recovery_requests: 0,
      },
      plain_output: {
        duration_ms: 2000,
        websocket_messages: 600,
        wire_ratio: 1.04,
        history_recovery_requests: 0,
        sequence_gaps: 0,
        silent_drops: 0,
      },
      ansi_unicode_output: { duration_ms: 3000, canvas_match: true, terminal_state_match: true },
      render_frames: { p95_ms: 17, p99_ms: 30, max_ms: 80 },
      ui_sentinel: { p95_ms: 40 },
      reconnect: {
        iterations: 20,
        goroutine_delta: 0,
        connection_delta: 0,
        live_attachment_delta: 0,
        heap_delta_mib: 10,
      },
      mirror_same_session: {
        sample_count: 30,
        p95_ms: 30,
        p99_ms: 45,
        reconnect_ms: 500,
      },
      multi_page_resize: {
        sample_count: 40,
        p95_ms: 60,
        p99_ms: 90,
        max_ms: 120,
        output_bytes: 1024,
        geometry_mismatches: 0,
        sequence_gaps: 0,
        history_recovery_requests: 0,
      },
    },
    functional: {
      mirror_same_session: {
        connected_views: 2,
        distinct_view_dimensions: true,
        shared_pty_uses_minimum_dimensions: true,
        identical_output_streams: true,
        identical_terminal_state: true,
        semantic_markers_visible_in_both: true,
        first_input_visible_in_both: true,
        reconnect_preserved_two_attachments: true,
        second_input_visible_in_both: true,
        resize_preserved_connections: true,
        renderer_error_count: 0,
      },
      multi_page_resize: {
        distinct_connection_ids: true,
        output_streams_match: true,
        terminal_state_match: true,
        detach_restored_remaining_view: true,
        external_session_preserved: true,
        renderer_error_count: 0,
      },
    },
    errors: [],
  };

  const result = evaluateStandalonePerformanceReport(report);
  assert.ok(result.failures.includes('performance runner must use headed hardware WebGL2'));
  assert.ok(result.failures.includes('performance runner used a software GPU renderer'));
});
