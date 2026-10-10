package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// ---------- Чат ----------
// Пока один канал — «Общий» (channel ''); колонка channel оставлена под каналы по предметам.
// Новые сообщения и удаления приходят всем открытым вкладкам через SSE (/api/chat/stream).

type ChatMessage struct {
	ID          int64     `db:"id" json:"id"`
	Channel     string    `db:"channel" json:"channel"`
	Body        string    `db:"body" json:"body"`
	CreatedAt   time.Time `db:"created_at" json:"created_at"`
	AuthorID    int64     `db:"author_id" json:"author_id"`
	AuthorName  string    `db:"author_name" json:"author_name"`
	AuthorPhoto *string   `db:"author_photo" json:"author_photo"`
}

var chatSelect = `SELECT m.id, m.channel, m.body, m.created_at, m.author_id,
		COALESCE(` + displayNameSQL("u.") + `, '') AS author_name, u.photo_url AS author_photo
	FROM chat_messages m JOIN users u ON u.id = m.author_id `

// chatChannels: каналы со счётчиком непрочитанных (чужие сообщения после последнего прочитанного).
func chatChannels(w http.ResponseWriter, r *http.Request) {
	var unread int
	err := db.Get(&unread, `SELECT COUNT(*) FROM chat_messages m LEFT JOIN chat_reads r ON r.user_id = ? AND r.channel = m.channel
		WHERE m.channel = '' AND m.id > COALESCE(r.last_id, 0) AND m.author_id <> ?`, userOf(r).ID, userOf(r).ID)
	if serverErr(w, err) {
		return
	}
	writeJSON(w, 200, []map[string]any{{"name": "", "unread": unread}})
}

// chatMessages: последние 50 сообщений канала (старее before — для «Показать ранние»;
// новее after — догрузить пропущенное после обрыва связи). В ответе — от старых к новым.
func chatMessages(w http.ResponseWriter, r *http.Request) {
	const pageSize = 50
	q := r.URL.Query()
	channel := q.Get("channel")
	before, _ := strconv.ParseInt(q.Get("before"), 10, 64)
	after, _ := strconv.ParseInt(q.Get("after"), 10, 64)
	list := []ChatMessage{}
	var err error
	switch {
	case after > 0:
		err = db.Select(&list, chatSelect+"WHERE m.channel = ? AND m.id > ? ORDER BY m.id LIMIT 500", channel, after)
	case before > 0:
		err = db.Select(&list, chatSelect+"WHERE m.channel = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?", channel, before, pageSize+1)
	default:
		err = db.Select(&list, chatSelect+"WHERE m.channel = ? ORDER BY m.id DESC LIMIT ?", channel, pageSize+1)
	}
	if serverErr(w, err) {
		return
	}
	hasMore := false
	if after == 0 {
		// просили на одно больше: если пришло — есть ранние; переворачиваем от старых к новым
		if hasMore = len(list) > pageSize; hasMore {
			list = list[:pageSize]
		}
		for i, j := 0, len(list)-1; i < j; i, j = i+1, j-1 {
			list[i], list[j] = list[j], list[i]
		}
	}
	writeJSON(w, 200, map[string]any{"messages": list, "hasMore": hasMore})
}

func chatSend(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Channel string `json:"channel"`
		Body    string `json:"body"`
	}
	if !decode(w, r, &in) {
		return
	}
	body := clip(in.Body, 2000)
	if body == "" {
		fail(w, 400, "Пустое сообщение")
		return
	}
	if in.Channel != "" {
		fail(w, 400, "Нет такого канала")
		return
	}
	res, err := db.Exec("INSERT INTO chat_messages (channel, author_id, body) VALUES (?, ?, ?)", in.Channel, userOf(r).ID, body)
	if serverErr(w, err) {
		return
	}
	id, _ := res.LastInsertId()
	var m ChatMessage
	if serverErr(w, db.Get(&m, chatSelect+"WHERE m.id = ?", id)) {
		return
	}
	broadcast(map[string]any{"message": m})
	writeJSON(w, 200, m)
}

// chatDelete: своё сообщение может удалить автор, любое — модератор и выше.
func chatDelete(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var m struct {
		AuthorID int64  `db:"author_id"`
		Channel  string `db:"channel"`
	}
	err := db.Get(&m, "SELECT author_id, channel FROM chat_messages WHERE id = ?", r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "Сообщение не найдено")
		return
	}
	if serverErr(w, err) {
		return
	}
	if m.AuthorID != u.ID && u.Role == "student" {
		fail(w, 403, "Можно удалить только своё сообщение")
		return
	}
	if _, err := db.Exec("DELETE FROM chat_messages WHERE id = ?", r.PathValue("id")); serverErr(w, err) {
		return
	}
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	broadcast(map[string]any{"deleted": id, "channel": m.Channel})
	respondOK(w)
}

// chatRead: канал прочитан до сообщения last_id (назад не откатываем).
func chatRead(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Channel string `json:"channel"`
		LastID  int64  `json:"last_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	_, err := db.Exec(`INSERT INTO chat_reads (user_id, channel, last_id) VALUES (?, ?, ?)
		ON DUPLICATE KEY UPDATE last_id = GREATEST(last_id, VALUES(last_id))`, userOf(r).ID, clip(in.Channel, 200), in.LastID)
	if !serverErr(w, err) {
		respondOK(w)
	}
}

// Подписчики потока: у каждой открытой вкладки свой канал событий.
var (
	subsMu sync.Mutex
	subs   = map[chan []byte]bool{}
)

// broadcast отправляет событие всем вкладкам; если вкладка не успевает читать — событие для неё пропускается
// (она догрузит пропущенное при следующем открытии канала).
func broadcast(v any) {
	b, _ := json.Marshal(v)
	subsMu.Lock()
	defer subsMu.Unlock()
	for c := range subs {
		select {
		case c <- b:
		default:
		}
	}
}

// chatStream — SSE: строка «data: {…}» на каждое событие; раз в 25 с пустой комментарий,
// чтобы nginx и мобильные сети не закрыли тихое соединение.
func chatStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	c := make(chan []byte, 32)
	subsMu.Lock()
	subs[c] = true
	subsMu.Unlock()
	defer func() {
		subsMu.Lock()
		delete(subs, c)
		subsMu.Unlock()
	}()

	rc := http.NewResponseController(w)
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	fmt.Fprint(w, ": ok\n\n")
	for {
		if rc.Flush() != nil {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case b := <-c:
			fmt.Fprintf(w, "data: %s\n\n", b)
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
		}
	}
}
