package main

import (
	"net/http"
	"time"
)

// ---------- Лист замен (распознавание) ----------

var ocrClient = &http.Client{Timeout: 2 * time.Minute}

// ocrSheet передаёт картинку листа сервису распознавания (отдельный контейнер kkmt-ocr, каталог ocr/)
// и возвращает его ответ как есть — построчно, сразу по мере прихода (в нём прогресс по ячейкам).
func ocrSheet(w http.ResponseWriter, r *http.Request) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, env("OCR_URL", "http://localhost:3001")+"/parse", http.MaxBytesReader(w, r.Body, 20<<20))
	if serverErr(w, err) {
		return
	}
	res, err := ocrClient.Do(req)
	if err != nil {
		fail(w, 502, "Сервис распознавания недоступен")
		return
	}
	defer res.Body.Close()
	w.Header().Set("Content-Type", res.Header.Get("Content-Type"))
	w.Header().Set("X-Accel-Buffering", "no") // иначе nginx придержит строки прогресса до конца ответа
	w.WriteHeader(res.StatusCode)
	rc := http.NewResponseController(w)
	buf := make([]byte, 4096)
	for {
		n, err := res.Body.Read(buf)
		if n > 0 {
			w.Write(buf[:n])
			rc.Flush()
		}
		if err != nil {
			return
		}
	}
}

// OcrAlias — память исправлений: как OCR прочитал (ocr) и что это на самом деле (value).
// kind — subject, teacher или room. Модератор подтверждает сверку — следующий лист с той же ошибкой сопоставится сразу.
type OcrAlias struct {
	Kind  string `db:"kind" json:"kind"`
	OCR   string `db:"ocr" json:"ocr"`
	Value string `db:"value" json:"value"`
}

func listOcrAliases(w http.ResponseWriter, r *http.Request) {
	list := []OcrAlias{}
	if !serverErr(w, db.Select(&list, "SELECT kind, ocr, value FROM ocr_aliases")) {
		writeJSON(w, 200, list)
	}
}

func saveOcrAliases(w http.ResponseWriter, r *http.Request) {
	var in []OcrAlias
	if !decode(w, r, &in) {
		return
	}
	if len(in) > 100 {
		fail(w, 400, "Слишком много исправлений")
		return
	}
	for _, a := range in {
		if (a.Kind != "subject" && a.Kind != "teacher" && a.Kind != "room") || a.OCR == "" {
			fail(w, 400, "Некорректное исправление")
			return
		}
	}
	tx, err := db.Beginx()
	if serverErr(w, err) {
		return
	}
	defer tx.Rollback()
	for _, a := range in {
		if err != nil {
			break
		}
		_, err = tx.Exec("INSERT INTO ocr_aliases (kind, ocr, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
			a.Kind, clip(a.OCR, 200), clip(a.Value, 200))
	}
	if err == nil {
		err = tx.Commit()
	}
	if !serverErr(w, err) {
		respondOK(w)
	}
}
