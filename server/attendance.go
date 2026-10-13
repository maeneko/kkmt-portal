package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
)

// ---------- Посещаемость ----------

// Mark — отметка одного человека из списка группы на одной паре; UserID есть, если он уже зарегистрирован (только в ответе).
type Mark struct {
	PairNo   int    `db:"pair_no" json:"pair_no"`
	RosterID int64  `db:"roster_id" json:"roster_id"`
	UserID   *int64 `db:"user_id" json:"user_id,omitempty"`
	Present  bool   `db:"present" json:"present"`
}

// listAttendance отдаёт отметки за дату: староста и выше видят всех, остальные — только свои.
func listAttendance(w http.ResponseWriter, r *http.Request) {
	date := r.URL.Query().Get("date")
	if !validDate(date) {
		fail(w, 400, "Некорректная дата")
		return
	}
	u := userOf(r)
	marks := []Mark{}
	err := db.Select(&marks, `SELECT a.pair_no, a.roster_id, r.user_id, a.present FROM attendance a JOIN roster r ON r.id = a.roster_id
		WHERE a.date = ? AND (? OR r.user_id = ?)`, date, u.Mod(), u.ID)
	if !serverErr(w, err) {
		writeJSON(w, 200, marks)
	}
}

// saveAttendance заменяет отметки пары за дату присланным списком и отправляет отсутствующих кураторам в VK.
// Некому отправить (нет куратора с привязанным VK или не настроен бот) — ошибка, отметки не сохраняются.
func saveAttendance(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Date    string `json:"date"`
		PairNo  int    `json:"pair_no"`
		Subject string `json:"subject"` // для сообщения в VK
		Marks   []Mark `json:"marks"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validDate(in.Date) || in.PairNo < 1 || in.PairNo > 12 || len(in.Marks) > 500 {
		fail(w, 400, "Некорректные данные")
		return
	}
	var peers []int64
	if serverErr(w, db.Select(&peers, "SELECT vk_id FROM users WHERE FIND_IN_SET('curator', titles) AND vk_id IS NOT NULL")) {
		return
	}
	if os.Getenv("VK_BOT_TOKEN") == "" {
		fail(w, 500, "Бот VK не настроен")
		return
	}
	if len(peers) == 0 {
		fail(w, 400, "Некому отправить: нужен куратор с привязанным VK")
		return
	}
	tx, err := db.Beginx()
	if serverErr(w, err) {
		return
	}
	defer tx.Rollback()
	_, err = tx.Exec("DELETE FROM attendance WHERE date = ? AND pair_no = ?", in.Date, in.PairNo)
	for _, m := range in.Marks {
		if err != nil {
			break
		}
		_, err = tx.Exec("INSERT INTO attendance (date, pair_no, roster_id, present, marked_by) VALUES (?, ?, ?, ?, ?)",
			in.Date, in.PairNo, m.RosterID, m.Present, userOf(r).ID)
	}
	if err == nil {
		err = tx.Commit()
	}
	if serverErr(w, err) {
		return
	}
	if err := notifyVK(peers, in.Date, in.PairNo, clip(in.Subject, 200), in.Marks); err != nil {
		log.Println("vk бот:", err)
		fail(w, 502, "Отметки сохранены, но куратору не отправлены: "+err.Error())
		return
	}
	respondOK(w)
}

// notifyVK отправляет список отсутствующих кураторам (peers — их VK ID) ботом сообщества VK (ключ VK_BOT_TOKEN).
// Успехом считается доставка хотя бы одному; иначе возвращается причина.
func notifyVK(peers []int64, date string, pair int, subject string, marks []Mark) error {
	var absent []int64
	for _, m := range marks {
		if !m.Present {
			absent = append(absent, m.RosterID)
		}
	}
	names := []string{}
	if len(absent) > 0 {
		q, args, err := sqlx.In("SELECT name FROM roster WHERE id IN (?) ORDER BY name", absent)
		if err == nil {
			err = db.Select(&names, q, args...)
		}
		if err != nil {
			return err
		}
	}
	d, _ := time.Parse("2006-01-02", date)
	text := fmt.Sprintf("Посещаемость (%s, %d пара)", d.Format("02.01.2006"), pair)
	if subject != "" {
		text += "\nПара: " + subject
	}
	if len(names) == 0 {
		text += fmt.Sprintf("\nПрисутствуют все (%d)", len(marks))
	} else {
		text += fmt.Sprintf("\nОтсутствуют (%d из %d):\n%s", len(names), len(marks), strings.Join(names, "\n"))
	}
	var first error
	for _, peer := range peers {
		err := vkSend(peer, clip(text, 4000))
		if err == nil {
			return nil
		}
		if first == nil {
			first = err
		}
	}
	return first
}

// vkSend пишет сообщение пользователю VK от имени сообщества.
func vkSend(peer int64, text string) error {
	resp, err := vkClient.PostForm("https://api.vk.com/method/messages.send", url.Values{
		"access_token": {os.Getenv("VK_BOT_TOKEN")}, "v": {"5.199"}, "peer_id": {strconv.FormatInt(peer, 10)}, "message": {text},
		"random_id": {strconv.FormatInt(time.Now().UnixNano()&0x7fffffff, 10)},
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var out struct {
		Error *struct {
			Code int    `json:"error_code"`
			Msg  string `json:"error_msg"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}
	switch {
	case out.Error == nil:
		return nil
	case out.Error.Code == 901:
		return errors.New("куратор не разрешил сообщения сообществу (нужно один раз написать боту)")
	default:
		return fmt.Errorf("VK: %s", out.Error.Msg)
	}
}
