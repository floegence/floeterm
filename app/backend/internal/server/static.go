package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// spaFileServer serves a Vite/SPA build directory and falls back to index.html for client-side routes.
func spaFileServer(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}

		clean := filepath.Clean(path)
		if strings.HasPrefix(clean, "..") {
			http.NotFound(w, r)
			return
		}

		abs := filepath.Join(dir, clean)
		if info, err := os.Stat(abs); err == nil && !info.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}

		// If this looks like a client-side route, serve the SPA entrypoint.
		if !strings.Contains(clean, ".") {
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/index.html"
			fs.ServeHTTP(w, r2)
			return
		}

		http.NotFound(w, r)
	})
}
