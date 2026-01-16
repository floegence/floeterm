package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/floegence/floeterm/app/backend/internal/server"
	terminal "github.com/floegence/floeterm/terminal-go"
)

func main() {
	var addr string
	var staticDir string
	flag.StringVar(&addr, "addr", ":8080", "HTTP listen address")
	flag.StringVar(&staticDir, "static", "", "path to app/web dist directory")
	flag.Parse()

	if staticDir == "" {
		staticDir = resolveDefaultStaticDir()
	}

	srv := server.New(server.Config{
		StaticDir: staticDir,
		ManagerConfig: terminal.ManagerConfig{
			// Keep UI responsiveness high.
			InitialResizeSuppressDuration: 200 * time.Millisecond,
			ResizeSuppressDuration:        150 * time.Millisecond,
		},
	})
	defer srv.Close()

	log.Printf("floeterm server listening on http://localhost%s", addr)
	if staticDir != "" {
		log.Printf("serving web from %s", staticDir)
	} else {
		log.Printf("no static dir configured; API only")
	}

	if err := http.ListenAndServe(addr, srv.Handler()); err != nil {
		log.Fatal(err)
	}
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
