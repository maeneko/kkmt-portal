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
	Titles      string  `db:"titles" json:"-"`                          // «headman»; наружу уходит списком titles (см. MarshalJSON)
	NeedRoster  bool    `db:"need_roster" json:"need_roster,omitempty"` // нужно выбрать своё имя в списке группы
	TGLinked    bool    `db:"tg_linked" json:"tg_linked,omitempty"`
	VKID        *int64  `db:"vk_id" json:"vk_id,omitempty"` // только в /api/me: в списках не выбирается
}

// MarshalJSON добавляет к пользователю список должностей (староста, куратор).
func (u User) MarshalJSON() ([]byte, error) {
	type plain User
	titles := []string{}
	if u.Titles != "" {
		titles = strings.Split(u.Titles, ",")
	}
	return json.Marshal(struct {
		plain
		TitleList []string `json:"titles"`
	}{plain(u), titles})
}

// Mod — есть права модерации: роль выше студента (в том числе куратор) или должность староста.
func (u *User) Mod() bool { return u.Role != "student" || u.Titles != "" }

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
	err = db.Get(&u, `SELECT u.id, u.username, u.photo_url, u.display_name, u.real_name, u.first_name, u.last_name, u.bio, u.role, u.titles, u.tg_id IS NOT NULL AS tg_linked,
			(u.role IN ('student', 'moderator') AND EXISTS (SELECT 1 FROM roster) AND NOT EXISTS (SELECT 1 FROM roster r WHERE r.user_id = u.id)) AS need_roster, u.vk_id
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
		if !userOf(r).Mod() {
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
	writeJSON(w, 200, map[string]any{"clientId": clientID(), "groupName": group, "devLogin": os.Getenv("DEV_LOGIN") == "1", "vkClientId": os.Getenv("VK_CLIENT_ID")})
}

// me — профиль вошедшего пользователя.
func me(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, userOf(r)) }

// unlinkSocial отвязывает Telegram или VK, если у пользователя остаётся другой способ входа.
func unlinkSocial(w http.ResponseWriter, r *http.Request) {
	col, other := "tg_id", "vk_id"
	switch r.PathValue("kind") {
	case "vk":
		col, other = other, col
	case "tg":
	default:
		fail(w, 404, "Not found")
		return
	}
	res, err := db.Exec("UPDATE users SET "+col+" = NULL WHERE id = ? AND "+other+" IS NOT NULL", userOf(r).ID)
	if serverErr(w, err) {
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, 400, "Нельзя отвязать единственный способ входа")
		return
	}
	respondOK(w)
}

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
	needName // ключ верный, но имя в списке группы не выбрано
	badName  // выбранное имя уже занято
	noName   // в списке группы не осталось свободных имён
)

// signup — что новый участник присылает при регистрации; повторяется, пока вход не завершится.
type signup struct {
	Invite   string `json:"invite"`
	RosterID int64  `json:"rosterId"` // имя, выбранное в списке группы
}

// inviteRe — формат инвайт-ключа: 6 символов 0-9 и A-Z.
var inviteRe = regexp.MustCompile(`^[0-9A-Z]{6}$`)

// nullable превращает пустую строку в NULL для записи в базу.
func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// loginOrRegister: вход или регистрация. col — колонка с id в соцсети: "tg_id" или "vk_id".
// Новый пользователь, кроме владельца (OWNER_TG_ID), обязан передать инвайт и выбрать своё имя в списке группы.
func loginOrRegister(col string, tg tgData, s signup) (int64, loginResult, error) {
	tx, err := db.Beginx()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback() // после Commit ничего не делает

	var id int64
	err = tx.Get(&id, "SELECT id FROM users WHERE "+col+" = ? FOR UPDATE", tg.ID)
	switch {
	case err == nil:
		// имя и фамилию из соцсетей не берём; у Telegram обновляем ник и фото, у VK — ничего (профиль мог быть создан через Telegram)
		if col == "tg_id" {
			_, err = tx.Exec("UPDATE users SET username = ?, photo_url = ?, last_seen = NOW() WHERE id = ?",
				nullable(tg.Username), nullable(tg.PhotoURL), id)
		} else {
			_, err = tx.Exec("UPDATE users SET last_seen = NOW() WHERE id = ?", id)
		}
		if err != nil {
			return 0, 0, err
		}
	case errors.Is(err, sql.ErrNoRows):
		isOwner := col == "tg_id" && strconv.FormatInt(tg.ID, 10) == os.Getenv("OWNER_TG_ID")
		code := strings.ToUpper(strings.TrimSpace(s.Invite))
		var name string
		var claim int64
		if !isOwner {
			if s.Invite == "" {
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
			// новый участник обязательно выбирает своё имя в списке группы (ключ до этого не тратится)
			var free int
			if err := tx.Get(&free, "SELECT COUNT(*) FROM roster WHERE user_id IS NULL"); err != nil {
				return 0, 0, err
			}
			switch {
			case free == 0:
				return 0, noName, nil
			case s.RosterID == 0:
				return 0, needName, nil
			}
			err = tx.Get(&name, "SELECT name FROM roster WHERE id = ? AND user_id IS NULL FOR UPDATE", s.RosterID)
			if errors.Is(err, sql.ErrNoRows) {
				return 0, badName, nil
			}
			if err != nil {
				return 0, 0, err
			}
			claim = s.RosterID
		}
		role := "student"
		if isOwner {
			role, code = "owner", ""
		}
		res, err := tx.Exec("INSERT INTO users ("+col+", username, first_name, last_name, photo_url, real_name, role, invite_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			tg.ID, nullable(tg.Username), tg.FirstName, nullable(tg.LastName), nullable(tg.PhotoURL), nullable(name), role, nullable(code))
		if err != nil {
			return 0, 0, err
		}
		if id, err = res.LastInsertId(); err != nil {
			return 0, 0, err
		}
		if _, err := tx.Exec("INSERT INTO activity (actor_id, kind, text) VALUES (?, 'user', 'присоединился(ась) к группе')", id); err != nil {
			return 0, 0, err
		}
		if claim != 0 {
			if _, err := tx.Exec("UPDATE roster SET user_id = ? WHERE id = ?", id, claim); err != nil {
				return 0, 0, err
			}
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
func finishLogin(w http.ResponseWriter, col string, tg tgData, s signup) {
	id, res, err := loginOrRegister(col, tg, s)
	if serverErr(w, err) {
		return
	}
	switch res {
	case needInvite:
		writeJSON(w, 403, map[string]any{"needInvite": true, "error": "Нужен инвайт-ключ"})
	case badInvite:
		writeJSON(w, 403, map[string]any{"needInvite": true, "error": "Неверный или использованный ключ"})
	case needName, badName:
		// свободные имена отдаём только тому, кто прошёл проверку входа и ключа
		names := []RosterEntry{}
		if serverErr(w, db.Select(&names, "SELECT id, name FROM roster WHERE user_id IS NULL ORDER BY name")) {
			return
		}
		msg := "Выберите себя в списке"
		if res == badName {
			msg = "Это имя уже занято. Выберите другое"
		}
		writeJSON(w, 403, map[string]any{"needName": true, "names": names, "error": msg})
	case noName:
		fail(w, 403, "В списке группы нет свободных имён. Обратитесь к старосте")
	default:
		if !serverErr(w, startSession(w, id)) {
			respondOK(w)
		}
	}
}

func telegramLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDToken string `json:"idToken"`
		signup
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
	id, _ := c.ID.Int64()
	finishLogin(w, "tg_id", tgData{ID: id, Username: c.Username, PhotoURL: c.Picture}, in.signup)
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
		signup
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
	finishLogin(w, "tg_id", tgData{ID: in.TgID, FirstName: name, Username: nick}, in.signup)
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
	ID       json.Number `json:"id"` // Telegram присылает id то числом, то строкой — json.Number принимает оба
	Username string      `json:"preferred_username"`
	Picture  string      `json:"picture"`
	Nonce    string      `json:"nonce"`
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
