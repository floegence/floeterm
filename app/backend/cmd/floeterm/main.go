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

func main() {
	var addr string
	var staticDir string
	var logLevel string
	flag.StringVar(&addr, "addr", ":8080", "HTTP listen address")
	flag.StringVar(&staticDir, "static", "", "path to app/web dist directory")
	flag.StringVar(&logLevel, "log-level", "info", "log level: debug|info|warn|error")
	flag.Parse()

	if staticDir == "" {
		staticDir = resolveDefaultStaticDir()
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
		StaticDir: staticDir,
		ManagerConfig: terminal.ManagerConfig{
			Logger: logger,
			// Keep UI responsiveness high.
			InitialResizeSuppressDuration: 200 * time.Millisecond,
			ResizeSuppressDuration:        150 * time.Millisecond,
		},
	})
	defer srv.Close()

	logger.Info("floeterm server listening", "addr", addr)
	if staticDir != "" {
		logger.Info("serving web", "staticDir", staticDir)
		if url := displayLocalAccessURL(addr); url != "" {
			logger.Info("open in browser", "url", url)
		}
	} else {
		logger.Info("no static dir configured; API only")
	}

	if err := http.ListenAndServe(addr, srv.Handler()); err != nil {
		logger.Error("http server exited", "error", err)
		os.Exit(1)
	}
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
