package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// ---------- Идеи ----------
// Идею предлагает любой; статус меняют модераторы. Каждая смена пишется в журнал (idea_events) — как таймлайн задачи в GitHub.

type IdeaEvent struct {
	ID        int64     `db:"id" json:"id"`
	IdeaID    int64     `db:"idea_id" json:"-"`
	Status    string    `db:"status" json:"status"`
	Note      string    `db:"note" json:"note"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
	ActorName string    `db:"actor_name" json:"actor_name"`
}

type Idea struct {
	ID          int64       `db:"id" json:"id"`
	Title       string      `db:"title" json:"title"`
	Body        string      `db:"body" json:"body"`
	Status      string      `db:"status" json:"status"`
	HasImage    bool        `db:"has_image" json:"has_image"`
	CreatedAt   time.Time   `db:"created_at" json:"created_at"`
	AuthorID    int64       `db:"author_id" json:"author_id"`
	AuthorName  string      `db:"author_name" json:"author_name"`
	AuthorPhoto *string     `db:"author_photo" json:"author_photo"`
	Events      []IdeaEvent `db:"-" json:"events"`
}

var ideaStatusText = map[string]string{"open": "открыта", "clarify": "нужны подробности", "accepted": "принята", "rejected": "отклонена", "done": "реализована"}

var ideaStatuses = map[string]bool{"open": true, "accepted": true, "rejected": true, "done": true, "clarify": true}

func listIdeas(w http.ResponseWriter, r *http.Request) {
	ideas := []Idea{}
	err := db.Select(&ideas, `SELECT i.id, i.title, i.body, i.status, i.image IS NOT NULL AS has_image, i.created_at, u.id AS author_id,
			`+displayNameSQL("u.")+` AS author_name, u.photo_url AS author_photo
		FROM ideas i JOIN users u ON u.id = i.author_id ORDER BY i.id DESC`)
	if serverErr(w, err) {
		return
	}
	events := []IdeaEvent{}
	err = db.Select(&events, `SELECT e.id, e.idea_id, e.status, e.note, e.created_at,
			COALESCE(`+displayNameSQL("u.")+`, '') AS actor_name
		FROM idea_events e LEFT JOIN users u ON u.id = e.actor_id ORDER BY e.id`)
	if serverErr(w, err) {
		return
	}
	byID := map[int64]*Idea{}
	for i := range ideas {
		ideas[i].Events = []IdeaEvent{}
		byID[ideas[i].ID] = &ideas[i]
	}
	for _, e := range events {
		if i := byID[e.IdeaID]; i != nil {
			i.Events = append(i.Events, e)
		}
	}
	writeJSON(w, 200, ideas)
}

func createIdea(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title string `json:"title"`
		Body  string `json:"body"`
	}
	if !decode(w, r, &in) {
		return
	}
	title := clip(in.Title, 120)
	if title == "" {
		fail(w, 400, "Укажите название идеи")
		return
	}
	res, err := db.Exec("INSERT INTO ideas (author_id, title, body) VALUES (?, ?, ?)", userOf(r).ID, title, clip(in.Body, 2000))
	if serverErr(w, err) {
		return
	}
	id, _ := res.LastInsertId()
	logActivity(userOf(r).ID, "idea", "предложил(а) идею «"+title+"»")
	writeJSON(w, 200, map[string]int64{"id": id})
}

// setIdeaStatus меняет статус идеи и пишет событие в журнал (с необязательным комментарием).
func setIdeaStatus(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !ideaStatuses[in.Status] {
		fail(w, 400, "Некорректный статус")
		return
	}
	note := clip(in.Note, 500)
	if in.Status == "clarify" && note == "" {
		fail(w, 400, "Напишите, что нужно уточнить")
		return
	}
	res, err := db.Exec("UPDATE ideas SET status = ? WHERE id = ? AND status <> ?", in.Status, r.PathValue("id"), in.Status)
	if serverErr(w, err) {
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, 400, "Идея не найдена или уже в этом статусе")
		return
	}
	_, err = db.Exec("INSERT INTO idea_events (idea_id, actor_id, status, note) VALUES (?, ?, ?, ?)", r.PathValue("id"), userOf(r).ID, in.Status, note)
	if serverErr(w, err) {
		return
	}
	logActivity(userOf(r).ID, "idea", "изменил(а) статус идеи «"+ideaTitle(r.PathValue("id"))+"»: "+ideaStatusText[in.Status])
	respondOK(w)
}

// replyIdea — ответ автора на просьбу объяснить подробнее: идея снова открыта, ответ попадает в журнал.
func replyIdea(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Note string `json:"note"`
	}
	if !decode(w, r, &in) {
		return
	}
	note := clip(in.Note, 500)
	if note == "" {
		fail(w, 400, "Напишите ответ")
		return
	}
	res, err := db.Exec("UPDATE ideas SET status = 'open' WHERE id = ? AND author_id = ? AND status = 'clarify'", r.PathValue("id"), userOf(r).ID)
	if serverErr(w, err) {
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, 403, "Ответить может автор, когда попросили подробности")
		return
	}
	_, err = db.Exec("INSERT INTO idea_events (idea_id, actor_id, status, note) VALUES (?, ?, 'open', ?)", r.PathValue("id"), userOf(r).ID, note)
	if serverErr(w, err) {
		return
	}
	logActivity(userOf(r).ID, "idea", "ответил(а) по идее «"+ideaTitle(r.PathValue("id"))+"»")
	respondOK(w)
}

// imageExt — какие картинки можно прикрепить к идее (по Content-Type запроса).
var imageExt = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}

// uploadIdeaImage прикрепляет скриншот к своей идее: тело запроса — сам файл (до 5 МБ).
func uploadIdeaImage(w http.ResponseWriter, r *http.Request) {
	ext, ok := imageExt[r.Header.Get("Content-Type")]
	if !ok {
		fail(w, 400, "Нужна картинка: png, jpg, webp или gif")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 5<<20))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		fail(w, 413, "Скриншот слишком большой (до 5 МБ)")
		return
	}
	if serverErr(w, err) {
		return
	}
	if len(data) == 0 {
		fail(w, 400, "Пустой файл")
		return
	}
	rnd := make([]byte, 16)
	rand.Read(rnd)
	stored := hex.EncodeToString(rnd) + "." + ext
	if serverErr(w, os.WriteFile(filepath.Join(uploadDir, stored), data, 0o644)) {
		return
	}
	res, err := db.Exec("UPDATE ideas SET image = ? WHERE id = ? AND author_id = ? AND image IS NULL", stored, r.PathValue("id"), userOf(r).ID)
	if err == nil {
		if n, _ := res.RowsAffected(); n == 0 {
			os.Remove(filepath.Join(uploadDir, stored))
			fail(w, 403, "Скриншот можно прикрепить только к своей идее, один раз")
			return
		}
		respondOK(w)
		return
	}
	os.Remove(filepath.Join(uploadDir, stored))
	serverErr(w, err)
}

func ideaImage(w http.ResponseWriter, r *http.Request) {
	var stored sql.NullString
	err := db.Get(&stored, "SELECT image FROM ideas WHERE id = ?", r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) || !stored.Valid {
		fail(w, 404, "Скриншота нет")
		return
	}
	if serverErr(w, err) {
		return
	}
	file, err := os.Open(filepath.Join(uploadDir, stored.String))
	if err != nil {
		fail(w, 404, "Скриншота нет")
		return
	}
	defer file.Close()
	st, _ := file.Stat()
	w.Header().Set("Content-Type", mime.TypeByExtension(filepath.Ext(stored.String)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, "", st.ModTime(), file)
}

// deleteIdea: свою идею удаляет автор, любую — модератор.
func deleteIdea(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var stored sql.NullString
	db.Get(&stored, "SELECT image FROM ideas WHERE id = ?", r.PathValue("id"))
	res, err := db.Exec("DELETE FROM ideas WHERE id = ? AND (author_id = ? OR ?)", r.PathValue("id"), u.ID, u.Role != "student")
	if serverErr(w, err) {
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, 403, "Можно удалить только свою идею")
		return
	}
	if stored.Valid {
		os.Remove(filepath.Join(uploadDir, stored.String))
	}
	respondOK(w)
}
