package main

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"database/sql"

	"github.com/golang-jwt/jwt/v5"
)

// ---------- Пользователь и сессии ----------

// User — публичные данные пользователя. То же отдаётся в /api/me и в списках;
// tg_id и инвайт-код наружу не уходят.
type User struct {
	ID          int64   `db:"id" json:"id"`
	Username    *string `db:"username" json:"username"`
	PhotoURL    *string `db:"photo_url" json:"photo_url"`
	DisplayName *string `db:"display_name" json:"display_name"`
	RealName    *string `db:"real_name" json:"real_name,omitempty"` // фамилия и имя: видят только модераторы и выше (и сам пользователь)
	FirstName   string  `db:"first_name" json:"first_name"`
	LastName    *string `db:"last_name" json:"last_name"`
	Bio         string  `db:"bio" json:"bio"`
	Role        string  `db:"role" json:"role"`
}

// userKey — ключ, под которым текущий пользователь лежит в контексте запроса.
type userKey struct{}

// Сессия живёт в cookie; в базе хранится только sha256 токена,
// поэтому утечка таблицы sessions не даёт войти под чужим именем.
const (
	cookieName  = "kkmt_session"
	sessionDays = 30
)

// userOf возвращает вошедшего пользователя или nil, если запрос без сессии.
func userOf(r *http.Request) *User { u, _ := r.Context().Value(userKey{}).(*User); return u }

// sha — sha256 строки в hex (так токен сессии хранится в базе).
func sha(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

// startSession создаёт сессию на 30 дней и выдаёт браузеру cookie с токеном.
func startSession(w http.ResponseWriter, userID int64) error {
	b := make([]byte, 32)
	rand.Read(b)
	token := hex.EncodeToString(b)
	_, err := db.Exec("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))",
		sha(token), userID, sessionDays)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure: os.Getenv("COOKIE_SECURE") == "1", MaxAge: sessionDays * 86400,
	})
	return nil
}

// sessionUser находит пользователя по cookie; nil — нет cookie, сессия неизвестна или истекла.
func sessionUser(r *http.Request) *User {
	c, err := r.Cookie(cookieName)
	if err != nil || c.Value == "" {
		return nil
	}
	var u User
	err = db.Get(&u, `SELECT u.id, u.username, u.photo_url, u.display_name, u.real_name, u.first_name, u.last_name, u.bio, u.role
		FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > NOW()`, sha(c.Value))
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			log.Println("сессия:", err)
		}
		return nil
	}
	return &u
}

// authed пропускает дальше только вошедших пользователей, остальным отвечает 401.
func authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if userOf(r) == nil {
			fail(w, 401, "Не авторизован")
			return
		}
		next(w, r)
	}
}

// moderator пропускает модераторов, админов и главного админа (студентам — 403).
func moderator(next http.HandlerFunc) http.HandlerFunc {
	return authed(func(w http.ResponseWriter, r *http.Request) {
		if userOf(r).Role == "student" {
			fail(w, 403, "Только для модераторов")
			return
		}
		next(w, r)
	})
}

// admin пропускает только админов и главного админа (студентам и модераторам — 403).
func admin(next http.HandlerFunc) http.HandlerFunc {
	return authed(func(w http.ResponseWriter, r *http.Request) {
		if role := userOf(r).Role; role != "admin" && role != "owner" {
			fail(w, 403, "Только для админов")
			return
		}
		next(w, r)
	})
}

// limited: не больше 30 попыток входа с одного IP за 15 минут.
var (
	hitsMu sync.Mutex
	hits   = map[string][]time.Time{}
)

func limited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" { // за nginx настоящий адрес — последний в списке
			ip = strings.TrimSpace(xff[strings.LastIndex(xff, ",")+1:])
		}
		now := time.Now()
		hitsMu.Lock()
		recent := hits[ip][:0]
		for _, t := range hits[ip] {
			if now.Sub(t) < 15*time.Minute {
				recent = append(recent, t)
			}
		}
		blocked := len(recent) >= 30
		if !blocked {
			recent = append(recent, now)
		}
		hits[ip] = recent
		hitsMu.Unlock()
		if blocked {
			fail(w, 429, "Слишком много попыток, попробуйте позже")
			return
		}
		next(w, r)
	}
}

// ---------- Вход ----------

// config отдаёт фронту настройки входа и название группы (доступно без входа).
func config(w http.ResponseWriter, r *http.Request) {
	group, set := os.LookupEnv("GROUP_NAME")
	if !set {
		group = "Группа"
	}
	writeJSON(w, 200, map[string]any{"clientId": clientID(), "groupName": group, "devLogin": os.Getenv("DEV_LOGIN") == "1"})
}

// me — профиль вошедшего пользователя.
func me(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, userOf(r)) }

// logout удаляет сессию из базы и стирает cookie.
func logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(cookieName); err == nil {
		if _, err := db.Exec("DELETE FROM sessions WHERE token_hash = ?", sha(c.Value)); serverErr(w, err) {
			return
		}
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Path: "/", MaxAge: -1})
	respondOK(w)
}

// tgData — то, что нужно знать о человеке, чтобы войти или зарегистрировать его.
type tgData struct {
	ID                                      int64
	FirstName, LastName, Username, PhotoURL string
}

// loginResult — чем закончилась попытка входа.
type loginResult int

const (
	loginOK loginResult = iota
	needInvite
	badInvite
	needName // ключ верный, но не введены фамилия и имя
)

// inviteRe — формат инвайт-ключа: 6 символов 0-9 и A-Z.
var inviteRe = regexp.MustCompile(`^[0-9A-Z]{6}$`)

// nullable превращает пустую строку в NULL для записи в базу.
func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// loginOrRegister: вход или регистрация. Новый пользователь, кроме владельца (OWNER_TG_ID), обязан передать инвайт.
func loginOrRegister(tg tgData, invite, realName string) (int64, loginResult, error) {
	tx, err := db.Beginx()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback() // после Commit ничего не делает

	var id int64
	err = tx.Get(&id, "SELECT id FROM users WHERE tg_id = ? FOR UPDATE", tg.ID)
	switch {
	case err == nil:
		_, err = tx.Exec("UPDATE users SET username = ?, first_name = ?, last_name = ?, photo_url = ?, last_seen = NOW() WHERE id = ?",
			nullable(tg.Username), tg.FirstName, nullable(tg.LastName), nullable(tg.PhotoURL), id)
		if err != nil {
			return 0, 0, err
		}
	case errors.Is(err, sql.ErrNoRows):
		isOwner := strconv.FormatInt(tg.ID, 10) == os.Getenv("OWNER_TG_ID")
		code := strings.ToUpper(strings.TrimSpace(invite))
		if !isOwner {
			if invite == "" {
				return 0, needInvite, nil
			}
			var found string
			err := tx.Get(&found, "SELECT code FROM invites WHERE code = ? AND used_count < max_uses FOR UPDATE", code)
			if !inviteRe.MatchString(code) || errors.Is(err, sql.ErrNoRows) {
				return 0, badInvite, nil
			}
			if err != nil {
				return 0, 0, err
			}
			// новый участник обязательно указывает «Фамилия Имя» (ключ до этого не тратится)
			if len(strings.Fields(realName)) < 2 {
				return 0, needName, nil
			}
		}
		role := "student"
		if isOwner {
			role, code = "owner", ""
		}
		res, err := tx.Exec("INSERT INTO users (tg_id, username, first_name, last_name, photo_url, real_name, role, invite_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			tg.ID, nullable(tg.Username), tg.FirstName, nullable(tg.LastName), nullable(tg.PhotoURL), nullable(clip(strings.Join(strings.Fields(realName), " "), 64)), role, nullable(code))
		if err != nil {
			return 0, 0, err
		}
		if id, err = res.LastInsertId(); err != nil {
			return 0, 0, err
		}
		if code != "" {
			if _, err := tx.Exec("UPDATE invites SET used_count = used_count + 1, used_by = ?, used_at = NOW() WHERE code = ?", id, code); err != nil {
				return 0, 0, err
			}
		}
	default:
		return 0, 0, err
	}
	return id, loginOK, tx.Commit()
}

// finishLogin: ответ на попытку входа — сессия или просьба о ключе.
func finishLogin(w http.ResponseWriter, tg tgData, invite, realName string) {
	id, res, err := loginOrRegister(tg, invite, realName)
	if serverErr(w, err) {
		return
	}
	switch res {
	case needInvite:
		writeJSON(w, 403, map[string]any{"needInvite": true, "error": "Нужен инвайт-ключ"})
	case badInvite:
		writeJSON(w, 403, map[string]any{"needInvite": true, "error": "Неверный или использованный ключ"})
	case needName:
		writeJSON(w, 403, map[string]any{"needName": true, "error": "Введите фамилию и имя"})
	default:
		if !serverErr(w, startSession(w, id)) {
			respondOK(w)
		}
	}
}

func telegramLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDToken  string `json:"idToken"`
		Invite   string `json:"invite"`
		RealName string `json:"realName"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := verifyIDToken(in.IDToken)
	if err != nil {
		log.Println("id_token отклонён:", err)
		fail(w, 401, "Вход через Telegram не подтверждён. Попробуйте ещё раз")
		return
	}
	first := c.GivenName
	if first == "" {
		first = c.Name
	}
	id, _ := c.ID.Int64()
	finishLogin(w, tgData{id, first, c.FamilyName, c.Username, c.Picture}, in.Invite, in.RealName)
}

// Только для локальной разработки (DEV_LOGIN=1): вход без Telegram.
func devLogin(w http.ResponseWriter, r *http.Request) {
	if os.Getenv("DEV_LOGIN") != "1" {
		w.WriteHeader(404)
		return
	}
	var in struct {
		TgID     int64  `json:"tgId"`
		Username string `json:"username"`
		Name     string `json:"name"`
		Invite   string `json:"invite"`
		RealName string `json:"realName"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.TgID <= 0 {
		fail(w, 400, "tgId")
		return
	}
	nick := clip(strings.TrimPrefix(in.Username, "@"), 32)
	if nick == "" {
		nick = fmt.Sprintf("dev%d", in.TgID)
	}
	name := clip(in.Name, 64)
	if name == "" {
		name = nick
	}
	finishLogin(w, tgData{ID: in.TgID, FirstName: name, Username: nick}, in.Invite, in.RealName)
}

// ---------- Telegram: id_token (OpenID Connect) ----------
// Telegram присылает подписанный JWT; проверяем подпись по встроенным ключам (серверу не нужен доступ к Telegram),
// а также iss/aud/exp и nonce. Секрет клиента не нужен. Ключи обновляет: npm run update-jwks

//go:embed telegram_jwks.json
var jwksJSON []byte

var telegramKeys = func() map[string]crypto.PublicKey {
	var list []struct{ Kty, Kid, N, E, X, Y string }
	if err := json.Unmarshal(jwksJSON, &list); err != nil {
		panic(err)
	}
	keys := map[string]crypto.PublicKey{}
	for _, k := range list {
		b := func(s string) *big.Int {
			v, _ := base64.RawURLEncoding.DecodeString(s)
			return new(big.Int).SetBytes(v)
		}
		switch k.Kty {
		case "RSA":
			keys[k.Kid] = &rsa.PublicKey{N: b(k.N), E: int(b(k.E).Int64())}
		case "EC":
			keys[k.Kid] = &ecdsa.PublicKey{Curve: elliptic.P256(), X: b(k.X), Y: b(k.Y)}
		}
	}
	return keys
}()

func clientID() string {
	if id := os.Getenv("TELEGRAM_CLIENT_ID"); id != "" {
		return id
	}
	// у новых ботов Client ID совпадает с числом в начале токена бота
	return regexp.MustCompile(`^\d+`).FindString(os.Getenv("BOT_TOKEN"))
}

type tgClaims struct {
	jwt.RegisteredClaims
	ID         json.Number `json:"id"` // Telegram присылает id то числом, то строкой — json.Number принимает оба
	Name       string      `json:"name"`
	GivenName  string      `json:"given_name"`
	FamilyName string      `json:"family_name"`
	Username   string      `json:"preferred_username"`
	Picture    string      `json:"picture"`
	Nonce      string      `json:"nonce"`
}

func verifyIDToken(token string) (*tgClaims, error) {
	cid := clientID()
	if cid == "" {
		return nil, errors.New("client_id не настроен")
	}
	c := &tgClaims{}
	_, err := jwt.ParseWithClaims(token, c, func(t *jwt.Token) (any, error) {
		if k, ok := telegramKeys[fmt.Sprint(t.Header["kid"])]; ok {
			return k, nil
		}
		return nil, errors.New("ключ не найден")
	}, jwt.WithValidMethods([]string{"RS256", "ES256"}), jwt.WithIssuer("https://oauth.telegram.org"),
		jwt.WithAudience(cid), jwt.WithExpirationRequired(), jwt.WithIssuedAt())
	if err != nil {
		return nil, err
	}
	if !checkNonce(c.Nonce) {
		return nil, fmt.Errorf("nonce не подходит или истёк (%d символов)", len(c.Nonce))
	}
	if id, err := c.ID.Int64(); err != nil || id <= 0 {
		return nil, errors.New("нет id (нужен scope profile)")
	}
	return c, nil
}

// nonce без хранения состояния: срок.случайное.hmac. Ключ случайный на время жизни процесса.
// Ключ задаётся при миграции (из таблицы settings), чтобы переживать перезапуски.
var nonceKey []byte

func nonceMAC(body string) string {
	m := hmac.New(sha256.New, nonceKey)
	m.Write([]byte(body))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func nonce(w http.ResponseWriter, r *http.Request) {
	rnd := make([]byte, 12)
	rand.Read(rnd)
	body := fmt.Sprintf("%d.%s", time.Now().Add(30*time.Minute).UnixMilli(), base64.RawURLEncoding.EncodeToString(rnd))
	writeJSON(w, 200, map[string]string{"nonce": body + "." + nonceMAC(body)})
}

func checkNonce(n string) bool {
	i := strings.LastIndex(n, ".")
	if i < 0 || !hmac.Equal([]byte(n[i+1:]), []byte(nonceMAC(n[:i]))) {
		return false
	}
	exp, err := strconv.ParseInt(n[:strings.Index(n, ".")], 10, 64)
	return err == nil && exp > time.Now().UnixMilli()
}
