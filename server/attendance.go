package main

import (
	"encoding/json"
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

// Mark — отметка одного человека на одной паре.
type Mark struct {
	PairNo  int   `db:"pair_no" json:"pair_no"`
	UserID  int64 `db:"user_id" json:"user_id"`
	Present bool  `db:"present" json:"present"`
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
	err := db.Select(&marks, "SELECT pair_no, user_id, present FROM attendance WHERE date = ? AND (? OR user_id = ?)", date, u.Role != "student", u.ID)
	if !serverErr(w, err) {
		writeJSON(w, 200, marks)
	}
}

// saveAttendance заменяет отметки пары за дату присланным списком.
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
		_, err = tx.Exec("INSERT INTO attendance (date, pair_no, user_id, present, marked_by) VALUES (?, ?, ?, ?, ?)",
			in.Date, in.PairNo, m.UserID, m.Present, userOf(r).ID)
	}
	if err == nil {
		err = tx.Commit()
	}
	if serverErr(w, err) {
		return
	}
	go notifyVK(in.Date, in.PairNo, clip(in.Subject, 200), in.Marks)
	respondOK(w)
}

// notifyVK отправляет список отсутствующих в чат через бота сообщества VK. Нужны VK_BOT_TOKEN (ключ доступа сообщества
// с правом «сообщения») и VK_BOT_PEER_ID (беседа: 2000000000 + номер чата; личные сообщения: id пользователя); без них не делает ничего.
// Ошибка отправки только пишется в лог: отметка уже сохранена.
func notifyVK(date string, pair int, subject string, marks []Mark) {
	token, peer := os.Getenv("VK_BOT_TOKEN"), os.Getenv("VK_BOT_PEER_ID")
	if token == "" || peer == "" {
		return
	}
	var absent []int64
	for _, m := range marks {
		if !m.Present {
			absent = append(absent, m.UserID)
		}
	}
	names := []string{}
	if len(absent) > 0 {
		q, args, err := sqlx.In("SELECT COALESCE(NULLIF(real_name, ''), "+displayNameSQL("")+") FROM users WHERE id IN (?) ORDER BY 1", absent)
		if err == nil {
			err = db.Select(&names, q, args...)
		}
		if err != nil {
			log.Println("vk бот: имена:", err)
			return
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
	resp, err := vkClient.PostForm("https://api.vk.com/method/messages.send", url.Values{
		"access_token": {token}, "v": {"5.199"}, "peer_id": {peer}, "message": {clip(text, 4000)},
		"random_id": {strconv.FormatInt(time.Now().UnixNano()&0x7fffffff, 10)},
	})
	if err != nil {
		log.Println("vk бот:", err)
		return
	}
	defer resp.Body.Close()
	var out struct {
		Error *struct {
			Code int    `json:"error_code"`
			Msg  string `json:"error_msg"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Error != nil {
		log.Println("vk бот: отправка не удалась:", err, out.Error)
	}
}
