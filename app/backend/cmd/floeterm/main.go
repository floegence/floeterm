package main

import (
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/floegence/floeterm/app/backend/internal/server"
	terminal "github.com/floegence/floeterm/terminal-go"
)

type statePaths struct {
	Root string
}

func main() {
	var addr string
	var staticDir string
	var stateDir string
	var logLevel string
	var performanceDiagnostics bool
	var historyLatencyMin time.Duration
	var historyLatencyMax time.Duration
	var historyLatencySeed int64
	var transportLatencyMin time.Duration
	var transportLatencyMax time.Duration
	var transportLatencySeed int64
	flag.StringVar(&addr, "addr", ":8080", "HTTP listen address")
	flag.StringVar(&staticDir, "static", "", "path to app/web dist directory")
	flag.StringVar(&stateDir, "state-dir", "", "path to durable FloeTerm state (defaults to the user config directory)")
	flag.StringVar(&logLevel, "log-level", "info", "log level: debug|info|warn|error")
	flag.BoolVar(&performanceDiagnostics, "performance-diagnostics", false, "enable loopback performance diagnostics endpoint")
	flag.DurationVar(&historyLatencyMin, "history-latency-min", 0, "example-only minimum delay for each semantic history request")
	flag.DurationVar(&historyLatencyMax, "history-latency-max", 0, "example-only maximum delay for each semantic history request")
	flag.Int64Var(&historyLatencySeed, "history-latency-seed", 1, "deterministic seed for example semantic history latency")
	flag.DurationVar(&transportLatencyMin, "transport-latency-min", 0, "example-only minimum delay for every HTTP/WebSocket data direction")
	flag.DurationVar(&transportLatencyMax, "transport-latency-max", 0, "example-only maximum delay for every HTTP/WebSocket data direction")
	flag.Int64Var(&transportLatencySeed, "transport-latency-seed", 1, "deterministic seed for example transport latency")
	flag.Parse()

	if staticDir == "" {
		staticDir = resolveDefaultStaticDir()
	}
	paths, err := resolveStatePaths(stateDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid -state-dir: %v\n", err)
		os.Exit(2)
	}

	level := terminal.LogInfo
	switch strings.ToLower(strings.TrimSpace(logLevel)) {
	case "debug":
		level = terminal.LogDebug
	case "info", "":
		level = terminal.LogInfo
	case "warn", "warning":
		level = terminal.LogWarn
	case "error":
		level = terminal.LogError
	default:
		fmt.Fprintf(os.Stderr, "warning: unknown -log-level=%q, falling back to info\n", logLevel)
		level = terminal.LogInfo
	}

	logger := terminal.NewStdLogger(level)
	srv := server.New(server.Config{
		StaticDir:                    staticDir,
		EnablePerformanceDiagnostics: performanceDiagnostics,
		HistoryLatencyMin:            historyLatencyMin,
		HistoryLatencyMax:            historyLatencyMax,
		HistoryLatencySeed:           historyLatencySeed,
		TransportLatencyMin:          transportLatencyMin,
		TransportLatencyMax:          transportLatencyMax,
		TransportLatencySeed:         transportLatencySeed,
		ManagerConfig: terminal.ManagerConfig{
			Logger: logger,
			ShellArgsProvider: terminal.DefaultShellArgsProvider{
				EnableCommandLifecycle: true,
			},
			ShellInitWriter: terminal.DefaultShellInitWriter{
				EnableCommandLifecycle: true,
			},
			// Keep UI responsiveness high.
			InitialResizeSuppressDuration: 200 * time.Millisecond,
			ResizeSuppressDuration:        150 * time.Millisecond,
		},
	})
	defer srv.Close()

	listener, err := net.Listen("tcp", addr)
	if err != nil {
		logger.Error("floeterm server failed to listen", "addr", addr, "error", err)
		os.Exit(1)
	}
	defer listener.Close()
	actualAddr := listener.Addr().String()
	logger.Info("floeterm server listening", "addr", actualAddr)
	logger.Info("using durable state", "stateDir", paths.Root)
	if historyLatencyMax > 0 {
		logger.Info("semantic history latency simulation enabled", "min", historyLatencyMin, "max", historyLatencyMax, "seed", historyLatencySeed)
	}
	if transportLatencyMax > 0 {
		logger.Info("example transport latency simulation enabled", "min", transportLatencyMin, "max", transportLatencyMax, "seed", transportLatencySeed)
	}
	if staticDir != "" {
		logger.Info("serving web", "staticDir", staticDir)
		if url := displayLocalAccessURL(actualAddr); url != "" {
			logger.Info("open in browser", "url", url)
		}
	} else {
		logger.Info("no static dir configured; API only")
	}

	if err := http.Serve(listener, srv.Handler()); err != nil {
		logger.Error("http server exited", "error", err)
		os.Exit(1)
	}
}

func resolveStatePaths(configuredRoot string) (statePaths, error) {
	root := strings.TrimSpace(configuredRoot)
	if root == "" {
		configRoot, err := os.UserConfigDir()
		if err != nil {
			return statePaths{}, fmt.Errorf("resolve user config directory: %w", err)
		}
		root = filepath.Join(configRoot, "floeterm")
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return statePaths{}, fmt.Errorf("resolve state directory: %w", err)
	}
	return statePaths{Root: absoluteRoot}, nil
}

func displayLocalAccessURL(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return ""
	}

	// We usually listen on 0.0.0.0 / :: for LAN access, but "localhost" is the
	// most helpful address to show in logs for local browsing.
	switch host {
	case "", "0.0.0.0", "::":
		host = "localhost"
	}

	return "http://" + net.JoinHostPort(host, port)
}

func resolveDefaultStaticDir() string {
	candidates := []string{
		filepath.Join("..", "web", "dist"),
		filepath.Join("app", "web", "dist"),
	}
	for _, candidate := range candidates {
		index := filepath.Join(candidate, "index.html")
		if info, err := os.Stat(index); err == nil && !info.IsDir() {
			if abs, err := filepath.Abs(candidate); err == nil {
				return abs
			}
			return candidate
		}
	}
	fmt.Fprintln(os.Stderr, "warning: could not find app/web dist (run `make app-web-build` and pass -static)")
	return ""
}
