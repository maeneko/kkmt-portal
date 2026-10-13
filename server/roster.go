package main

import (
	"net/http"
	"strconv"
	"strings"
)

// ---------- Список группы ----------
// Человек при регистрации выбирает в нём своё «Фамилия Имя»; одно имя достаётся одному человеку, свободных видно только вошедшим.
// Список ведёт админ. Пока он пуст, имя вводят руками (как раньше).

// RosterEntry — имя из списка группы; UserID и Holder заполнены, если имя уже выбрано.
type RosterEntry struct {
	ID     int64   `db:"id" json:"id"`
	Name   string  `db:"name" json:"name"`
	UserID *int64  `db:"user_id" json:"user_id,omitempty"`
	Holder *string `db:"holder" json:"holder,omitempty"`
	Nick   *string `db:"nick" json:"nick,omitempty"`   // @ник из Telegram, если человек зарегистрирован
	Photo  *string `db:"photo" json:"photo,omitempty"` // его фото
}

// cleanName приводит «Фамилия  Имя» к одному пробелу; ok — есть фамилия и имя.
func cleanName(s string) (string, bool) {
	f := strings.Fields(s)
	return clip(strings.Join(f, " "), 64), len(f) >= 2
}

// freeNames — имена, которые ещё никто не выбрал.
func freeNames(w http.ResponseWriter, r *http.Request) {
	list := []RosterEntry{}
	if !serverErr(w, db.Select(&list, "SELECT id, name FROM roster WHERE user_id IS NULL ORDER BY name")) {
		writeJSON(w, 200, list)
	}
}

// claimName: вошедший выбирает своё имя в списке группы (один раз).
func claimName(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID int64 `json:"id"`
	}
	if !decode(w, r, &in) {
		return
	}
	uid := userOf(r).ID
	tx, err := db.Beginx()
	if serverErr(w, err) {
		return
	}
	defer tx.Rollback()
	var has int
	if err := tx.Get(&has, "SELECT COUNT(*) FROM roster WHERE user_id = ?", uid); serverErr(w, err) {
		return
	}
	if has > 0 {
		fail(w, 400, "Имя уже выбрано")
		return
	}
	res, err := tx.Exec("UPDATE roster SET user_id = ? WHERE id = ? AND user_id IS NULL", uid, in.ID)
	if serverErr(w, err) {
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, 409, "Это имя уже занято")
		return
	}
	if _, err := tx.Exec("UPDATE users u JOIN roster r ON r.user_id = u.id SET u.real_name = r.name WHERE u.id = ?", uid); serverErr(w, err) {
		return
	}
	if !serverErr(w, tx.Commit()) {
		respondOK(w)
	}
}

// assignName: староста и выше назначают участнику (в том числе себе) другое имя из списка группы;
// прежнее имя освобождается и достаётся другим. Вручную имя не вводится.
func assignName(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID int64 `json:"id"`
	}
	if !decode(w, r, &in) {
		return
	}
	uid, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	tx, err := db.Beginx()
	if serverErr(w, err) {
		return
	}
	defer tx.Rollback()
	var n int
	if err := tx.Get(&n, "SELECT COUNT(*) FROM users WHERE id = ?", uid); serverErr(w, err) {
		return
	}
	if n == 0 {
		fail(w, 404, "Не найдено")
		return
	}
	if _, err := tx.Exec("UPDATE roster SET user_id = NULL WHERE user_id = ?", uid); serverErr(w, err) {
		return
	}
	res, err := tx.Exec("UPDATE roster SET user_id = ? WHERE id = ? AND user_id IS NULL", uid, in.ID)
	if serverErr(w, err) {
		return
	}
	if c, _ := res.RowsAffected(); c == 0 {
		fail(w, 409, "Это имя уже занято")
		return
	}
	if _, err := tx.Exec("UPDATE users u JOIN roster r ON r.user_id = u.id SET u.real_name = r.name WHERE u.id = ?", uid); serverErr(w, err) {
		return
	}
	if !serverErr(w, tx.Commit()) {
		respondOK(w)
	}
}

// listRoster — весь список группы с тем, кто какое имя выбрал (админка).
func listRoster(w http.ResponseWriter, r *http.Request) {
	list := []RosterEntry{}
	err := db.Select(&list, `SELECT r.id, r.name, r.user_id, `+displayNameSQL("u.")+` AS holder, u.username AS nick, u.photo_url AS photo
		FROM roster r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.name`)
	if !serverErr(w, err) {
		writeJSON(w, 200, list)
	}
}

// addRoster добавляет имена списком, по одному «Фамилия Имя» в строке; повторы и некорректные строки пропускаются.
func addRoster(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Names string `json:"names"`
	}
	if !decode(w, r, &in) {
		return
	}
	lines := strings.Split(in.Names, "\n")
	if len(lines) > 300 {
		fail(w, 400, "Слишком много имён за раз")
		return
	}
	added := 0
	for _, l := range lines {
		name, ok := cleanName(l)
		if !ok {
			continue
		}
		res, err := db.Exec("INSERT IGNORE INTO roster (name) VALUES (?)", name)
		if serverErr(w, err) {
			return
		}
		n, _ := res.RowsAffected()
		added += int(n)
	}
	writeJSON(w, 200, map[string]int{"added": added})
}

// deleteRoster убирает имя из списка; у человека, который его выбрал, «Фамилия Имя» остаётся, но выбрать придётся заново.
func deleteRoster(w http.ResponseWriter, r *http.Request) {
	if _, err := db.Exec("DELETE FROM roster WHERE id = ?", r.PathValue("id")); !serverErr(w, err) {
		respondOK(w)
	}
}

// releaseRoster освобождает имя: человек увидит выбор снова (если выбрал не себя), а имя снова доступно другим.
func releaseRoster(w http.ResponseWriter, r *http.Request) {
	if _, err := db.Exec("UPDATE roster SET user_id = NULL WHERE id = ?", r.PathValue("id")); !serverErr(w, err) {
		respondOK(w)
	}
}
