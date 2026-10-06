package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// makeToken подписывает id_token своим ключом, подменяя ключ Telegram с тем же kid.
func makeToken(t *testing.T, claims jwt.MapClaims) string {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	telegramKeys["oidc-es256-1"] = &key.PublicKey
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	tok.Header["kid"] = "oidc-es256-1"
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func freshNonce(t *testing.T) string {
	rec := httptest.NewRecorder()
	nonce(rec, httptest.NewRequest("GET", "/api/auth/nonce", nil))
	body := rec.Body.String() // {"nonce":"..."}
	return strings.Split(body, `"`)[3]
}

func goodClaims(t *testing.T) jwt.MapClaims {
	return jwt.MapClaims{
		"iss": "https://oauth.telegram.org", "aud": "123", "exp": time.Now().Add(time.Hour).Unix(),
		"iat": time.Now().Unix(), "id": 42, "name": "Иван", "nonce": freshNonce(t),
	}
}

func TestVerifyIDToken(t *testing.T) {
	t.Setenv("TELEGRAM_CLIENT_ID", "123")

	c, err := verifyIDToken(makeToken(t, goodClaims(t)))
	if err != nil || c.ID != 42 || c.Name != "Иван" {
		t.Fatalf("верный токен отклонён: %v %+v", err, c)
	}

	cases := map[string]func(jwt.MapClaims){
		"чужой aud":      func(m jwt.MapClaims) { m["aud"] = "999" },
		"чужой iss":      func(m jwt.MapClaims) { m["iss"] = "https://evil.example" },
		"просрочен":      func(m jwt.MapClaims) { m["exp"] = time.Now().Add(-time.Minute).Unix() },
		"нет nonce":      func(m jwt.MapClaims) { m["nonce"] = "" },
		"подделан nonce": func(m jwt.MapClaims) { m["nonce"] = "9999999999999.abc.def" },
		"нет id":         func(m jwt.MapClaims) { delete(m, "id") },
	}
	for name, mutate := range cases {
		m := goodClaims(t)
		mutate(m)
		if _, err := verifyIDToken(makeToken(t, m)); err == nil {
			t.Errorf("%s: токен принят, а должен быть отклонён", name)
		}
	}

	// подпись другим ключом: токен подписан, но ключ Telegram в списке другой
	tok := makeToken(t, goodClaims(t))
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	telegramKeys["oidc-es256-1"] = &other.PublicKey
	if _, err := verifyIDToken(tok); err == nil {
		t.Error("подпись чужим ключом принята")
	}
}
