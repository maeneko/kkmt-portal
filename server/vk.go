package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

// ---------- VK ID (OAuth 2.1 + PKCE) ----------
// Браузер уходит на id.vk.com и возвращается на /api/auth/vk/callback с кодом. Сервер меняет код на токен
// (секрет не нужен: PKCE) и берёт имя и фото из user_info. Результат отдаётся фронту во фрагменте URL (#vk=…),
// чтобы дальше шёл обычный путь входа: инвайт → «Фамилия Имя» → сессия.

const vkCookie = "kkmt_vk"

var vkClient = &http.Client{Timeout: 10 * time.Second}

// vkPass — подписанные данные человека из VK; фронт возвращает их в POST /api/auth/vk.
type vkPass struct {
	ID                 int64
	First, Last, Photo string
	Exp                int64
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func vkRedirectURI(r *http.Request) string {
	scheme := "http"
	if os.Getenv("COOKIE_SECURE") == "1" {
		scheme = "https"
	}
	return scheme + "://" + r.Host + "/api/auth/vk/callback"
}

// vkStart отправляет браузер на страницу входа VK. verifier живёт в cookie, state подписан им:
// callback принимается только в том браузере, где вход начался.
func vkStart(w http.ResponseWriter, r *http.Request) {
	cid := os.Getenv("VK_CLIENT_ID")
	if cid == "" {
		fail(w, 404, "Вход через VK не настроен")
		return
	}
	rnd := make([]byte, 32)
	rand.Read(rnd)
	verifier := b64(rnd)
	http.SetCookie(w, &http.Cookie{
		Name: vkCookie, Value: verifier, Path: "/api/auth/vk", HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure: os.Getenv("COOKIE_SECURE") == "1", MaxAge: 600,
	})
	challenge := sha256.Sum256([]byte(verifier))
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {cid},
		"redirect_uri":          {vkRedirectURI(r)},
		"state":                 {nonceMAC(verifier)},
		"code_challenge":        {b64(challenge[:])},
		"code_challenge_method": {"S256"},
		"scope":                 {"vkid.personal_info"},
	}
	http.Redirect(w, r, "https://id.vk.com/authorize?"+q.Encode(), http.StatusFound)
}

// vkPost — запрос к API VK ID, ответ разбирается в out.
func vkPost(method string, form url.Values, out any) error {
	resp, err := vkClient.PostForm("https://id.vk.com/oauth2/"+method, form)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("%s: %s", method, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// vkProfile меняет код на токен и спрашивает у VK, кто это.
func vkProfile(r *http.Request, verifier string) (vkPass, error) {
	q, cid := r.URL.Query(), os.Getenv("VK_CLIENT_ID")
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	err := vkPost("auth", url.Values{
		"grant_type": {"authorization_code"}, "code": {q.Get("code")}, "code_verifier": {verifier}, "client_id": {cid},
		"device_id": {q.Get("device_id")}, "redirect_uri": {vkRedirectURI(r)}, "state": {q.Get("state")},
	}, &tok)
	if err != nil || tok.AccessToken == "" {
		return vkPass{}, fmt.Errorf("обмен кода: %v", err)
	}
	var info struct {
		User struct {
			ID        json.Number `json:"user_id"` // VK присылает id строкой
			FirstName string      `json:"first_name"`
			LastName  string      `json:"last_name"`
			Avatar    string      `json:"avatar"`
		} `json:"user"`
	}
	if err := vkPost("user_info", url.Values{"client_id": {cid}, "access_token": {tok.AccessToken}}, &info); err != nil {
		return vkPass{}, err
	}
	id, err := info.User.ID.Int64()
	if err != nil || id <= 0 {
		return vkPass{}, errors.New("нет user_id")
	}
	return vkPass{id, info.User.FirstName, info.User.LastName, info.User.Avatar, time.Now().Add(30 * time.Minute).Unix()}, nil
}

// vkCallback: вошедший пользователь привязывает VK к своему аккаунту, остальные получают пропуск для входа.
func vkCallback(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(vkCookie)
	http.SetCookie(w, &http.Cookie{Name: vkCookie, Path: "/api/auth/vk", MaxAge: -1})
	if err != nil || !hmac.Equal([]byte(r.URL.Query().Get("state")), []byte(nonceMAC(c.Value))) || r.URL.Query().Get("code") == "" {
		log.Println("vk: state не подходит или нет кода:", r.URL.Query().Get("error"))
		http.Redirect(w, r, "/#vk_error=1", http.StatusFound)
		return
	}
	p, err := vkProfile(r, c.Value)
	if err != nil {
		log.Println("vk:", err)
		http.Redirect(w, r, "/#vk_error=1", http.StatusFound)
		return
	}
	if u := userOf(r); u != nil {
		_, err := db.Exec("UPDATE users SET vk_id = ? WHERE id = ?", p.ID, u.ID)
		var me *mysql.MySQLError
		switch {
		case errors.As(err, &me) && me.Number == 1062:
			http.Redirect(w, r, "/#vk_error=taken", http.StatusFound)
		case err != nil:
			log.Println("vk: привязка:", err)
			http.Redirect(w, r, "/#vk_error=1", http.StatusFound)
		default:
			http.Redirect(w, r, "/#vk=linked", http.StatusFound)
		}
		return
	}
	body, _ := json.Marshal(p)
	payload := b64(body)
	// name и photo — только для показа на шаге ключа; сервер им не верит, всё берёт из подписанного пропуска
	q := url.Values{"vk": {payload + "." + nonceMAC("vk."+payload)}, "name": {p.First + " " + p.Last}, "photo": {p.Photo}}
	http.Redirect(w, r, "/#"+q.Encode(), http.StatusFound)
}

func vkLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		VKToken  string `json:"vkToken"`
		Invite   string `json:"invite"`
		RealName string `json:"realName"`
	}
	if !decode(w, r, &in) {
		return
	}
	i := strings.LastIndex(in.VKToken, ".")
	if i < 0 || !hmac.Equal([]byte(in.VKToken[i+1:]), []byte(nonceMAC("vk."+in.VKToken[:i]))) {
		fail(w, 401, "Вход через VK не подтверждён. Попробуйте ещё раз")
		return
	}
	var p vkPass
	body, err := base64.RawURLEncoding.DecodeString(in.VKToken[:i])
	if err != nil || json.Unmarshal(body, &p) != nil || p.Exp < time.Now().Unix() {
		fail(w, 401, "Вход через VK не подтверждён. Попробуйте ещё раз")
		return
	}
	finishLogin(w, "vk_id", tgData{ID: p.ID, FirstName: p.First, LastName: p.Last, PhotoURL: p.Photo}, in.Invite, in.RealName)
}
