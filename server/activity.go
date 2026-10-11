package main

import (
	"fmt"
	"log"
	"net/http"
	"time"
)

// ---------- Общая лента ----------
// Журнал событий группы: новости, идеи, материалы, ДЗ, расписание, действия с пользователями.
// Запись делает logActivity в самих обработчиках; текст — продолжение фразы после имени («добавил(а) материал «…»»).
// Для новостей kind — news_global / news_group, текст — сам пост.

type Activity struct {
	ID         int64     `db:"id" json:"id"`
	Kind       string    `db:"kind" json:"kind"`
	Text       string    `db:"text" json:"text"`
	CreatedAt  time.Time `db:"created_at" json:"created_at"`
	ActorName  string    `db:"actor_name" json:"actor_name"`
	ActorPhoto *string   `db:"actor_photo" json:"actor_photo"`
}

func logActivity(actor int64, kind, text string) {
	if _, err := db.Exec("INSERT INTO activity (actor_id, kind, text) VALUES (?, ?, ?)", actor, kind, clip(text, 500)); err != nil {
		log.Println("журнал событий:", err)
	}
}

func listActivity(w http.ResponseWriter, r *http.Request) {
	const pageSize = 20
	query := `SELECT a.id, a.kind, a.text, a.created_at, COALESCE(` + displayNameSQL("u.") + `, '') AS actor_name, u.photo_url AS actor_photo
		FROM activity a LEFT JOIN users u ON u.id = a.actor_id `
	args := []any{pageSize + 1}
	if before := r.URL.Query().Get("before"); before != "" && before != "0" {
		query += "WHERE a.id < ? "
		args = []any{before, pageSize + 1}
	}
	items := []Activity{}
	if serverErr(w, db.Select(&items, query+"ORDER BY a.id DESC LIMIT ?", args...)) {
		return
	}
	hasMore := len(items) > pageSize
	if hasMore {
		items = items[:pageSize]
	}
	writeJSON(w, 200, map[string]any{"items": items, "hasMore": hasMore})
}

// slotLabel — где именно изменили ДЗ или файл: пара на дату либо общий материал.
func slotLabel(date string, pair int) string {
	if pair == 0 {
		var title string
		if db.Get(&title, "SELECT title FROM materials WHERE DATE_ADD(CAST(? AS DATE), INTERVAL id DAY) = ?", generalDate, date) != nil {
			return "в материале"
		}
		return "в материале «" + title + "»"
	}
	d, _ := time.Parse("2006-01-02", date)
	if pair > solutionShift {
		return fmt.Sprintf("к решению пары %d на %s", pair-solutionShift, d.Format("02.01"))
	}
	return fmt.Sprintf("к паре %d на %s", pair, d.Format("02.01"))
}

// userName — имя пользователя для текста события (пусто, если такого нет).
func userName(id int64) string {
	var name string
	db.Get(&name, "SELECT "+displayNameSQL("")+" FROM users WHERE id = ?", id)
	return name
}

// ideaTitle — название идеи для текста события.
func ideaTitle(id string) string {
	var title string
	db.Get(&title, "SELECT title FROM ideas WHERE id = ?", id)
	return title
}

// shortDate — «02.01» из «2026-01-02».
func shortDate(date string) string {
	d, _ := time.Parse("2006-01-02", date)
	return d.Format("02.01")
}
