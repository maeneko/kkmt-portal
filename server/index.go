package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/joho/godotenv"
)

var (
	publicDir string
	uploadDir string
)

const csp = "default-src 'self'; base-uri 'self'; object-src 'none'; " +
	"frame-ancestors 'self'; " +
	"script-src 'self' https://oauth.telegram.org; " +
	"frame-src https://oauth.telegram.org; " +
	"img-src 'self' data: https://t.me https://*.telesco.pe https://*.telegram.org; " +
	"style-src 'self' 'unsafe-inline'; " +
	// аватарки Telegram загружает и кеширует service worker (fetch) — им нужен connect-src
	"connect-src 'self' https://oauth.telegram.org https://t.me https://*.telesco.pe https://*.telegram.org"

func main() {
	_ = godotenv.Load()

	if os.Getenv("DB_USER") == "" || os.Getenv("DB_NAME") == "" {
		log.Fatal("Не заданы DB_USER / DB_NAME")
	}

	publicDir = env("PUBLIC_DIR", "dist/public")
	uploadDir = env("UPLOAD_DIR", "uploads")

	db = initDB()

	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		log.Fatal(err)
	}

	go cleanupSessions()
	port := env("PORT", "3000")
	log.Printf("kkmt слушает :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, app(routes())))
}

// ---------- DATABASE ----------

func initDB() *sqlx.DB {
	var lastErr error

	for attempt := 1; attempt <= 10; attempt++ {
		conn, err := connectDB()
		if err == nil {
			if err = migrate(conn); err == nil {
				return conn
			}
			conn.Close()
		}

		lastErr = err
		log.Printf("БД недоступна (%d/10): %v", attempt, err)
		time.Sleep(3 * time.Second)
	}

	log.Fatal("Не удалось подключиться к БД: ", lastErr)
	return nil
}

func cleanupSessions() {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()

	for range ticker.C {
		if _, err := db.Exec(
			"DELETE FROM sessions WHERE expires_at < NOW()",
		); err != nil {
			log.Println("ошибка очистки сессий:", err)
		}
	}
}

// ---------- ROUTES ----------

// ---------- MIDDLEWARE ----------

func app(next http.Handler) http.Handler {
	return securityMiddleware(
		gzipMiddleware(
			recoveryMiddleware(
				sessionMiddleware(next),
			),
		),
	)
}

// gzipMiddleware сжимает JSON-ответы API (в 5–10 раз меньше — заметно на медленном интернете).
// Файлы ДЗ отдаются как есть: документы и картинки уже сжаты, а ServeFile сам отвечает на Range.
func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, "/api/") ||
			strings.HasPrefix(r.URL.Path, "/api/homework/files/") ||
			!strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		zw := gzip.NewWriter(w)
		defer zw.Close()
		next.ServeHTTP(gzipWriter{w, zw}, r)
	})
}

type gzipWriter struct {
	http.ResponseWriter
	zw *gzip.Writer
}

func (g gzipWriter) Write(b []byte) (int, error) { return g.zw.Write(b) }

func securityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()

		h.Set("Content-Security-Policy", csp)
		h.Set("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")

		next.ServeHTTP(w, r)
	})
}

func recoveryMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				log.Println("panic:", err)
				fail(w, http.StatusInternalServerError, "Ошибка сервера")
			}
		}()

		next.ServeHTTP(w, r)
	})
}

func sessionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if u := sessionUser(r); u != nil {
				ctx := context.WithValue(
					r.Context(),
					userKey{},
					u,
				)
				r = r.WithContext(ctx)
			}
		}

		next.ServeHTTP(w, r)
	})
}

// ---------- STATIC ----------

// static отдаёт сборку фронтенда; неизвестные пути — index.html (SPA).
// /assets/* с хешем в имени кешируются навсегда, html — с проверкой (no-cache), чтобы после деплоя сразу была новая версия.
func static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := filepath.Join(publicDir, filepath.Clean("/"+r.URL.Path))
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		path = filepath.Join(publicDir, "index.html")
		if info, err = os.Stat(path); err != nil {
			http.NotFound(w, r)
			return
		}
	}
	switch {
	case strings.HasPrefix(r.URL.Path, "/assets/"):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	case filepath.Ext(path) == ".html" || filepath.Base(path) == "sw.js":
		w.Header().Set("Cache-Control", "no-cache")
	}
	if !serveGzip(w, r, path, info) {
		http.ServeFile(w, r, path)
	}
}

// gzipCache — сжатые копии текстовых файлов сборки: сжимаем один раз, а не на каждый запрос.
var gzipCache sync.Map // путь|время изменения → []byte

// serveGzip отдаёт js/css/html/svg/json сжатыми, если браузер умеет gzip.
func serveGzip(w http.ResponseWriter, r *http.Request, path string, info os.FileInfo) bool {
	ext := filepath.Ext(path)
	if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") || !strings.Contains(".js.css.html.svg.json", ext) || ext == "" {
		return false
	}
	key := path + "|" + info.ModTime().String()
	data, ok := gzipCache.Load(key)
	if !ok {
		raw, err := os.ReadFile(path)
		if err != nil {
			return false
		}
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		zw.Write(raw)
		zw.Close()
		data, _ = gzipCache.LoadOrStore(key, buf.Bytes())
	}
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Add("Vary", "Accept-Encoding")
	w.Header().Set("Content-Type", mime.TypeByExtension(ext))
	http.ServeContent(w, r, "", info.ModTime(), bytes.NewReader(data.([]byte)))
	return true
}

// ---------- JSON ----------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set(
		"Content-Type",
		"application/json; charset=utf-8",
	)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{
		"error": msg,
	})
}

func respondOK(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, map[string]bool{
		"ok": true,
	})
}

func serverErr(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}

	log.Println("ошибка:", err)
	fail(w, http.StatusInternalServerError, "Ошибка сервера")
	return true
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	decoder := json.NewDecoder(
		http.MaxBytesReader(
			w,
			r.Body,
			100<<10,
		),
	)

	if err := decoder.Decode(v); err != nil && err.Error() != "EOF" {
		fail(w, http.StatusBadRequest, "Некорректный запрос")
		return false
	}

	return true
}

// ---------- HELPERS ----------

func env(key, def string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return def
}

func clip(s string, max int) string {
	runes := []rune(strings.TrimSpace(s))

	if len(runes) > max {
		return string(runes[:max])
	}

	return string(runes)
}
