package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/joho/godotenv"
)

// publicDir — собранный фронт (npm run build), uploadDir — файлы к домашним заданиям.
var (
	publicDir = env("PUBLIC_DIR", "dist/public")
	uploadDir = env("UPLOAD_DIR", "uploads")
)

// csp — Content-Security-Policy: разрешает только свои ресурсы и виджет входа Telegram.
const csp = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; " +
	"script-src 'self' https://oauth.telegram.org; frame-src https://oauth.telegram.org; " +
	"img-src 'self' data: https://t.me https://*.telesco.pe https://*.telegram.org; " +
	"style-src 'self' 'unsafe-inline'; connect-src 'self' https://oauth.telegram.org"

// main подключается к базе (до 10 попыток: в Docker MySQL может подняться позже сайта) и запускает сервер.
func main() {
	_ = godotenv.Load() // .env необязателен: в Docker переменные приходят из окружения
	if os.Getenv("DB_USER") == "" || os.Getenv("DB_NAME") == "" {
		log.Fatal("Не заданы DB_USER / DB_NAME: проверьте .env (шаблон — .env.example)")
	}

	for i := 1; ; i++ {
		var conn *sqlx.DB
		conn, err := connectDB()
		if err == nil {
			if err = migrate(conn); err == nil {
				db = conn
				break
			}
		}
		if i >= 10 {
			log.Fatal(err)
		}
		log.Printf("БД недоступна (попытка %d/10): %v", i, err)
		time.Sleep(3 * time.Second)
	}
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		log.Fatal(err)
	}

	// чистим просроченные сессии раз в час
	go func() {
		for range time.Tick(time.Hour) {
			db.Exec("DELETE FROM sessions WHERE expires_at < NOW()")
		}
	}()

	port := env("PORT", "3000")
	log.Printf("kkmt слушает :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, app(routes())))
}

// routes — все маршруты API в одном месте.
// authed — только для вошедших, admin — только для админов, limited — с ограничением частоты (защита от перебора).
func routes() *http.ServeMux {
	m := http.NewServeMux()

	m.HandleFunc("GET /api/config", config)
	m.HandleFunc("GET /api/auth/nonce", nonce)
	m.HandleFunc("POST /api/auth/telegram", limited(telegramLogin))
	m.HandleFunc("POST /api/auth/dev", limited(devLogin))
	m.HandleFunc("POST /api/auth/logout", logout)
	m.HandleFunc("GET /api/me", authed(me))
	m.HandleFunc("PATCH /api/me", authed(updateMe))

	m.HandleFunc("GET /api/users", authed(listUsers))
	m.HandleFunc("GET /api/users/{id}", authed(getUser))
	m.HandleFunc("GET /api/schedule", authed(schedule))

	m.HandleFunc("GET /api/posts", authed(listPosts))
	m.HandleFunc("POST /api/posts", admin(createPost))
	m.HandleFunc("PATCH /api/posts/{id}", admin(pinPost))
	m.HandleFunc("DELETE /api/posts/{id}", admin(deletePost))

	m.HandleFunc("GET /api/homework", authed(listHomework))
	m.HandleFunc("PUT /api/homework", admin(saveHomework))
	m.HandleFunc("POST /api/homework/files", admin(uploadFile))
	m.HandleFunc("GET /api/homework/files/{id}", authed(downloadFile))
	m.HandleFunc("DELETE /api/homework/files/{id}", admin(deleteFile))

	m.HandleFunc("GET /api/admin/invites", admin(listInvites))
	m.HandleFunc("POST /api/admin/invites", admin(createInvite))
	m.HandleFunc("DELETE /api/admin/invites/{code}", admin(deleteInvite))
	m.HandleFunc("GET /api/admin/users", admin(listUsers))
	m.HandleFunc("PATCH /api/admin/users/{id}", admin(setRole))
	m.HandleFunc("DELETE /api/admin/users/{id}", admin(deleteUser))
	m.HandleFunc("PUT /api/admin/schedule", admin(saveSchedule))
	m.HandleFunc("PUT /api/admin/pair-times", admin(savePairTimes))
	m.HandleFunc("PUT /api/admin/settings", admin(saveSettings))

	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "Not found") })
	m.HandleFunc("/", static)
	return m
}

// app: заголовки безопасности, перехват паник и загрузка пользователя по cookie для /api.
func app(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		// окно входа Telegram сообщает результат через window.opener — строгий same-origin это ломает
		h.Set("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")

		defer func() {
			if e := recover(); e != nil {
				log.Println("panic:", e)
				fail(w, 500, "Ошибка сервера")
			}
		}()
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if u := sessionUser(r); u != nil {
				r = r.WithContext(context.WithValue(r.Context(), userKey{}, u))
			}
		}
		next.ServeHTTP(w, r)
	})
}

// static отдаёт собранный фронт; любой неизвестный путь — index.html (SPA).
func static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := filepath.Join(publicDir, filepath.Clean("/"+r.URL.Path))
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		if strings.HasPrefix(r.URL.Path, "/assets/") { // имена файлов с хэшем — кэшируем навсегда
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		http.ServeFile(w, r, p)
		return
	}
	http.ServeFile(w, r, filepath.Join(publicDir, "index.html"))
}

// writeJSON отвечает клиенту JSON-ом с нужным статусом.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// fail отвечает ошибкой в формате {"error": "..."} — его показывает фронт.
func fail(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// respondOK — стандартный ответ {"ok": true} для операций без результата.
func respondOK(w http.ResponseWriter) { writeJSON(w, 200, map[string]bool{"ok": true}) }

// serverErr: при ошибке пишет в лог, отвечает 500 и возвращает true.
func serverErr(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	log.Println("ошибка:", err)
	fail(w, 500, "Ошибка сервера")
	return true
}

// decode читает JSON-тело (до 100 КБ); при ошибке сам отвечает 400.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 100<<10)).Decode(v); err != nil && err.Error() != "EOF" {
		fail(w, 400, "Некорректный запрос")
		return false
	}
	return true
}

// env возвращает переменную окружения или значение по умолчанию, если она пустая.
func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// clip убирает пробелы по краям и обрезает строку до max символов (считает символы, а не байты, чтобы не порвать кириллицу и эмодзи).
func clip(s string, max int) string {
	if r := []rune(strings.TrimSpace(s)); len(r) > max {
		return string(r[:max])
	} else {
		return string(r)
	}
}
