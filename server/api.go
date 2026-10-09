package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

const (
	// Поля пользователя, которые видны всем (без tg_id и инвайт-кода).
	userCols = "id, username, photo_url, display_name, first_name, last_name, bio, role"
	// Порядок в списках: главный админ, админы, студенты; внутри — по имени.
	userOrder = "ORDER BY FIELD(role,'owner','admin','moderator','student'), first_name"

	maxFileMB    = 50 // максимальный размер одного файла к домашнему заданию
	filesPerPair = 5  // сколько файлов можно прикрепить к одной паре
	filesGeneral = 50 // и к общим материалам

	// Общий материал №N — слот ДЗ с парой 0 и датой generalDate + N дней (но не позже generalEnd):
	// так текст и файлы материала используют те же таблицы и API, что и ДЗ.
	generalDate = "1000-01-01"
	generalEnd  = "1099-12-31"
	// Эталонное решение пары N — слот ДЗ с номером пары N+100: текст и файлы работают теми же запросами.
	solutionShift = 100
)

// displayNameSQL — SQL-выражение имени для показа: свой ник → «Имя Фамилия» → username.
// table — префикс таблицы с точкой ("u.") или пустая строка.
func displayNameSQL(table string) string {
	return fmt.Sprintf(`COALESCE(NULLIF(%[1]sdisplay_name, ''), NULLIF(CONCAT_WS(' ', %[1]sfirst_name, %[1]slast_name), ''), %[1]susername)`, table)
}

var (
	allowedExt = []string{"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "odg", "txt", "zip", "jpg", "jpeg", "png"}
	timeRe     = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
)

// validDate проверяет дату в формате ГГГГ-ММ-ДД.
func validDate(s string) bool { _, err := time.Parse("2006-01-02", s); return err == nil }

// validSlot проверяет слот ДЗ: дата и пара 1–10, эталонное решение пары (её номер + solutionShift) либо общий материал.
func validSlot(date string, pair int) bool {
	return validDate(date) && (pair >= 1 && pair <= 10 || pair > solutionShift && pair <= solutionShift+10 || pair == 0 && date > generalDate && date <= generalEnd)
}

// fileLimit — сколько файлов можно прикрепить к слоту.
func fileLimit(pair int) int {
	if pair == 0 {
		return filesGeneral
	}
	return filesPerPair
}

// ---------- Профиль и пользователи ----------

// colsFor — поля пользователей для запрашивающего: модераторам и выше ещё и реальное имя.
func colsFor(r *http.Request) string {
	if userOf(r).Role == "student" {
		return userCols
	}
	return userCols + ", real_name"
}

// listUsers — список всех пользователей (одноклассники в профиле и таблица в админке).
func listUsers(w http.ResponseWriter, r *http.Request) {
	users := []User{}
	if !serverErr(w, db.Select(&users, "SELECT "+colsFor(r)+" FROM users "+userOrder)) {
		writeJSON(w, 200, users)
	}
}

// getUser — профиль одного пользователя.
func getUser(w http.ResponseWriter, r *http.Request) {
	var u User
	err := db.Get(&u, "SELECT "+colsFor(r)+" FROM users WHERE id = ?", r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "Не найдено")
	} else if !serverErr(w, err) {
		writeJSON(w, 200, u)
	}
}

// updateMe меняет присланные поля: отображаемое имя (до 32 символов; пустое — имя из Telegram)
// и реальное имя «Фамилия Имя» (до 64 символов).
func updateMe(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DisplayName *string `json:"display_name"`
		RealName    *string `json:"real_name"`
	}
	if !decode(w, r, &in) {
		return
	}
	var err error
	if in.DisplayName != nil {
		_, err = db.Exec("UPDATE users SET display_name = ? WHERE id = ?", nullable(clip(*in.DisplayName, 32)), userOf(r).ID)
	}
	if err == nil && in.RealName != nil {
		_, err = db.Exec("UPDATE users SET real_name = ? WHERE id = ?", nullable(clip(*in.RealName, 64)), userOf(r).ID)
	}
	if !serverErr(w, err) {
		respondOK(w)
	}
}

// ---------- Лента ----------

// Post — пост ленты вместе с автором.
type Post struct {
	ID          int64     `db:"id" json:"id"`
	Body        string    `db:"body" json:"body"`
	Pinned      bool      `db:"pinned" json:"pinned"`
	CreatedAt   time.Time `db:"created_at" json:"created_at"`
	AuthorID    int64     `db:"author_id" json:"author_id"`
	AuthorName  *string   `db:"author_name" json:"author_name"`
	AuthorPhoto *string   `db:"author_photo" json:"author_photo"`
}

// listPosts отдаёт ленту страницами по 10 постов.
// Первая страница: закреплённые сверху, потом новые. Следующие: ?before=<id последнего поста> — только более старые.
func listPosts(w http.ResponseWriter, r *http.Request) {
	const pageSize = 10

	query := `SELECT p.id, p.body, p.pinned, p.created_at, u.id AS author_id,
			` + displayNameSQL("u.") + ` AS author_name, u.photo_url AS author_photo
		FROM posts p JOIN users u ON u.id = p.author_id `
	var args []any
	if before := r.URL.Query().Get("before"); before != "" && before != "0" {
		query += "WHERE p.id < ? ORDER BY p.id DESC LIMIT ?"
		args = []any{before, pageSize + 1}
	} else {
		query += "ORDER BY p.pinned DESC, p.id DESC LIMIT ?"
		args = []any{pageSize + 1}
	}

	// просим на один пост больше: если он пришёл — есть следующая страница
	posts := []Post{}
	if serverErr(w, db.Select(&posts, query, args...)) {
		return
	}
	hasMore := len(posts) > pageSize
	if hasMore {
		posts = posts[:pageSize]
	}
	writeJSON(w, 200, map[string]any{"posts": posts, "hasMore": hasMore})
}

// createPost публикует пост (до 5000 символов); только админы.
func createPost(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Body   string `json:"body"`
		Pinned bool   `json:"pinned"`
	}
	if !decode(w, r, &in) {
		return
	}
	body := clip(in.Body, 5000)
	if body == "" {
		fail(w, 400, "Пустой пост")
		return
	}
	res, err := db.Exec("INSERT INTO posts (author_id, body, pinned) VALUES (?, ?, ?)", userOf(r).ID, body, in.Pinned)
	if serverErr(w, err) {
		return
	}
	id, _ := res.LastInsertId()
	writeJSON(w, 200, map[string]int64{"id": id})
}

// pinPost закрепляет или открепляет пост.
func pinPost(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Pinned *bool `json:"pinned"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Pinned != nil {
		if _, err := db.Exec("UPDATE posts SET pinned = ? WHERE id = ?", *in.Pinned, r.PathValue("id")); serverErr(w, err) {
			return
		}
	}
	respondOK(w)
}

// deletePost удаляет пост.
func deletePost(w http.ResponseWriter, r *http.Request) {
	_, err := db.Exec("DELETE FROM posts WHERE id = ?", r.PathValue("id"))
	if !serverErr(w, err) {
		respondOK(w)
	}
}

// ---------- Расписание ----------

// PairTime — время начала и конца пары.
type PairTime struct {
	PairNo int    `db:"pair_no" json:"pair_no"`
	Start  string `db:"start_time" json:"start_time"`
	End    string `db:"end_time" json:"end_time"`
}

// Lesson — одна пара в недельном расписании. Parity: all — каждую неделю, odd/even — по нечётным/чётным.
type Lesson struct {
	ID      int64  `db:"id" json:"id"`
	Weekday int    `db:"weekday" json:"weekday"`
	PairNo  int    `db:"pair_no" json:"pair_no"`
	Parity  string `db:"parity" json:"parity"`
	Subject string `db:"subject" json:"subject"`
	Teacher string `db:"teacher" json:"teacher"`
	Room    string `db:"room" json:"room"`
	Kind    string `db:"kind" json:"kind"`
	Remote  bool   `db:"remote" json:"remote"`
}

// LessonChange — замена пары на конкретную дату; пустой Subject — пары нет.
type LessonChange struct {
	Date    string `db:"date" json:"date"`
	PairNo  int    `db:"pair_no" json:"pair_no"`
	Subject string `db:"subject" json:"subject"`
	Teacher string `db:"teacher" json:"teacher"`
	Room    string `db:"room" json:"room"`
	Kind    string `db:"kind" json:"kind"`
	Remote  bool   `db:"remote" json:"remote"`
}

// Teacher — контакты преподавателя; Name совпадает со строкой преподавателя в расписании.
type Teacher struct {
	Name  string `db:"name" json:"name"`
	Phone string `db:"phone" json:"phone"`
	Email string `db:"email" json:"email"`
	VK    string `db:"vk" json:"vk"` // имя профиля: vk.com/<vk>
	TG    string `db:"tg" json:"tg"` // имя профиля: t.me/<tg>
}

// Профиль соцсети из того, что ввёл модератор («@ivanov», «t.me/ivanov», «https://vk.com/id1»): только имя,
// ссылку собирает интерфейс — так в неё не попадёт чужой адрес.
var (
	tgRe = regexp.MustCompile(`^(?:https?://)?(?:www\.)?(?:t\.me|telegram\.me)/|^@`)
	vkRe = regexp.MustCompile(`^(?:https?://)?(?:www\.|m\.)?vk\.(?:com|ru)/|^@`)
	tgOk = regexp.MustCompile(`^[A-Za-z0-9_]{3,64}$`)
	vkOk = regexp.MustCompile(`^[A-Za-z0-9_.]{2,64}$`)
)

func profile(s string, prefix, ok *regexp.Regexp) (string, bool) {
	s = strings.TrimRight(prefix.ReplaceAllString(strings.TrimSpace(s), ""), "/")
	return s, s == "" || ok.MatchString(s)
}

// schedule отдаёт всё расписание: пары, замены, контакты преподавателей, звонки (обычные и субботние) и дату начала семестра (от неё считается чётность недели).
func schedule(w http.ResponseWriter, r *http.Request) {
	lessons, changes, teachers, times, satTimes, sem := []Lesson{}, []LessonChange{}, []Teacher{}, []PairTime{}, []PairTime{}, []string{}
	err := errors.Join(
		db.Select(&lessons, "SELECT id, weekday, pair_no, parity, subject, teacher, room, kind, remote FROM lessons ORDER BY weekday, pair_no"),
		db.Select(&changes, "SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, pair_no, subject, teacher, room, kind, remote FROM lesson_changes"),
		db.Select(&teachers, "SELECT name, phone, email, vk, tg FROM teachers"),
		db.Select(&times, "SELECT pair_no, start_time, end_time FROM pair_times ORDER BY pair_no"),
		db.Select(&satTimes, "SELECT pair_no, start_time, end_time FROM pair_times_sat ORDER BY pair_no"),
		db.Select(&sem, "SELECT v FROM settings WHERE k = 'semester_start'"),
	)
	if serverErr(w, err) {
		return
	}
	var semesterStart *string
	if len(sem) > 0 {
		semesterStart = &sem[0]
	}
	writeJSON(w, 200, map[string]any{"lessons": lessons, "changes": changes, "teachers": teachers, "times": times, "satTimes": satTimes, "semesterStart": semesterStart})
}

// ---------- Домашние задания и файлы ----------

// HomeworkFile — файл, прикреплённый к паре.
type HomeworkFile struct {
	ID   int64  `db:"id" json:"id"`
	Name string `db:"name" json:"name"`
	Size int64  `db:"size" json:"size"`
	Note string `db:"note" json:"note"` // что именно сделать в файле
	// кто загрузил или прикрепил файл; заполняется только в listHomework
	Author string `db:"author" json:"author"`
}

// homeworkItem — домашнее задание и файлы одной пары на одну дату.
type homeworkItem struct {
	Date   string         `json:"date"`
	PairNo int            `json:"pair_no"`
	Body   string         `json:"body"`
	Files  []HomeworkFile `json:"files"`
}

// Дз и файлы за период (для значков в расписании).
func listHomework(w http.ResponseWriter, r *http.Request) {
	from, to := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	if !validDate(from) || !validDate(to) {
		fail(w, 400, "from/to")
		return
	}
	var hw []struct {
		Date   string `db:"date"`
		PairNo int    `db:"pair_no"`
		Body   string `db:"body"`
	}
	var files []struct {
		HomeworkFile
		Date   string `db:"date"`
		PairNo int    `db:"pair_no"`
	}
	err := errors.Join(
		db.Select(&hw, "SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, pair_no, body FROM homework WHERE date BETWEEN ? AND ?", from, to),
		db.Select(&files, `SELECT f.id, DATE_FORMAT(f.date, '%Y-%m-%d') AS date, f.pair_no, f.original_name AS name, f.size, f.note,
				COALESCE(`+displayNameSQL("u.")+`, '') AS author
			FROM homework_files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.date BETWEEN ? AND ? ORDER BY f.id`, from, to),
	)
	if serverErr(w, err) {
		return
	}
	items, index := []*homeworkItem{}, map[string]*homeworkItem{}
	get := func(date string, pair int) *homeworkItem {
		key := fmt.Sprint(date, "|", pair)
		if index[key] == nil {
			index[key] = &homeworkItem{Date: date, PairNo: pair, Files: []HomeworkFile{}}
			items = append(items, index[key])
		}
		return index[key]
	}
	for _, h := range hw {
		get(h.Date, h.PairNo).Body = h.Body
	}
	for _, f := range files {
		g := get(f.Date, f.PairNo)
		g.Files = append(g.Files, f.HomeworkFile)
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

// saveHomework сохраняет текст ДЗ для пары на дату; пустой текст удаляет запись.
func saveHomework(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Date   string `json:"date"`
		PairNo int    `json:"pair_no"`
		Body   string `json:"body"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validSlot(in.Date, in.PairNo) {
		fail(w, 400, "Некорректная дата или пара")
		return
	}
	var err error
	if body := clip(in.Body, 5000); body == "" {
		_, err = db.Exec("DELETE FROM homework WHERE date = ? AND pair_no = ?", in.Date, in.PairNo)
	} else {
		_, err = db.Exec(`INSERT INTO homework (date, pair_no, body, updated_by) VALUES (?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE body = VALUES(body), updated_by = VALUES(updated_by)`, in.Date, in.PairNo, body, userOf(r).ID)
	}
	if !serverErr(w, err) {
		respondOK(w)
	}
}

// Загрузка: тело запроса — сам файл, имя в ?name=, пара в ?date=&pair_no=
func uploadFile(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	date, name := q.Get("date"), clip(path.Base(q.Get("name")), 200)
	var pair int
	fmt.Sscan(q.Get("pair_no"), &pair)
	if !validSlot(date, pair) || q.Get("name") == "" {
		fail(w, 400, "Некорректные параметры")
		return
	}
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))
	if !slices.Contains(allowedExt, ext) {
		fail(w, 400, fmt.Sprintf("Тип .%s не разрешён. Можно: %s", ext, strings.Join(allowedExt, ", ")))
		return
	}
	var count int
	if serverErr(w, db.Get(&count, "SELECT COUNT(*) FROM homework_files WHERE date = ? AND pair_no = ?", date, pair)) {
		return
	}
	if count >= fileLimit(pair) {
		fail(w, 400, fmt.Sprintf("Не больше %d файлов", fileLimit(pair)))
		return
	}
	rnd := make([]byte, 16)
	rand.Read(rnd)
	stored := hex.EncodeToString(rnd) + "." + ext
	// пишем сразу на диск: файл до 50 МБ не должен целиком лежать в памяти
	file, err := os.Create(filepath.Join(uploadDir, stored))
	if serverErr(w, err) {
		return
	}
	size, err := io.Copy(file, http.MaxBytesReader(w, r.Body, maxFileMB<<20))
	file.Close()
	var tooBig *http.MaxBytesError
	switch {
	case errors.As(err, &tooBig):
		err = nil
		fail(w, 413, fmt.Sprintf("Файл слишком большой (до %d МБ)", maxFileMB))
	case err == nil && size == 0:
		fail(w, 400, "Пустой файл")
	case err == nil:
		var res sql.Result
		res, err = db.Exec("INSERT INTO homework_files (date, pair_no, original_name, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)",
			date, pair, name, stored, size, userOf(r).ID)
		if err == nil {
			id, _ := res.LastInsertId()
			writeJSON(w, 200, HomeworkFile{ID: id, Name: name, Size: size})
			return
		}
	}
	os.Remove(filepath.Join(uploadDir, stored))
	serverErr(w, err)
}

// downloadFile отдаёт файл на скачивание под его исходным именем.
func downloadFile(w http.ResponseWriter, r *http.Request) {
	var f struct {
		Original string `db:"original_name"`
		Stored   string `db:"stored_name"`
	}
	err := db.Get(&f, "SELECT original_name, stored_name FROM homework_files WHERE id = ?", r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "Файл не найден")
		return
	}
	if serverErr(w, err) {
		return
	}
	file, err := os.Open(filepath.Join(uploadDir, f.Stored))
	if err != nil {
		fail(w, 404, "Файл не найден")
		return
	}
	defer file.Close()
	st, _ := file.Stat()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+encodeURIComponent(f.Original))
	http.ServeContent(w, r, "", st.ModTime(), file)
}

// removeUnused удаляет файл с диска, если на него не осталось ссылок: один файл может быть прикреплён к нескольким парам.
func removeUnused(stored string) error {
	var left int
	if err := db.Get(&left, "SELECT COUNT(*) FROM homework_files WHERE stored_name = ?", stored); err != nil || left > 0 {
		return err
	}
	os.Remove(filepath.Join(uploadDir, stored))
	return nil
}

// deleteFile удаляет запись о файле и сам файл с диска.
func deleteFile(w http.ResponseWriter, r *http.Request) {
	var stored string
	err := db.Get(&stored, "SELECT stored_name FROM homework_files WHERE id = ?", r.PathValue("id"))
	if err == nil {
		if _, err = db.Exec("DELETE FROM homework_files WHERE id = ?", r.PathValue("id")); err == nil {
			err = removeUnused(stored)
		}
	} else if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	if !serverErr(w, err) {
		respondOK(w)
	}
}

// encodeURIComponent из JS: для заголовка Content-Disposition.
func encodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// saveFileNote сохраняет, что именно сделать в прикреплённом файле.
func saveFileNote(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Note string `json:"note"`
	}
	if !decode(w, r, &in) {
		return
	}
	_, err := db.Exec("UPDATE homework_files SET note = ? WHERE id = ?", clip(in.Note, 500), r.PathValue("id"))
	if !serverErr(w, err) {
		respondOK(w)
	}
}

// attachFile прикрепляет уже загруженный файл к другой паре: новая запись ссылается на тот же файл на диске.
func attachFile(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Date   string `json:"date"`
		PairNo int    `json:"pair_no"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validSlot(in.Date, in.PairNo) {
		fail(w, 400, "Некорректные параметры")
		return
	}
	var f HomeworkFile
	var stored string
	err := db.QueryRow("SELECT original_name, size, stored_name FROM homework_files WHERE id = ?", r.PathValue("id")).Scan(&f.Name, &f.Size, &stored)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "Файл не найден")
		return
	}
	var count int
	if err == nil {
		err = db.Get(&count, "SELECT COUNT(*) FROM homework_files WHERE date = ? AND pair_no = ?", in.Date, in.PairNo)
	}
	if serverErr(w, err) {
		return
	}
	if count >= fileLimit(in.PairNo) {
		fail(w, 400, fmt.Sprintf("Не больше %d файлов", fileLimit(in.PairNo)))
		return
	}
	res, err := db.Exec("INSERT INTO homework_files (date, pair_no, original_name, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)",
		in.Date, in.PairNo, f.Name, stored, f.Size, userOf(r).ID)
	if serverErr(w, err) {
		return
	}
	f.ID, _ = res.LastInsertId()
	writeJSON(w, 200, f)
}

// saveTeacher сохраняет контакты преподавателя (телефон, почта, ВК, Telegram); если все пустые — запись удаляется.
func saveTeacher(w http.ResponseWriter, r *http.Request) {
	var in Teacher
	if !decode(w, r, &in) {
		return
	}
	in.Name, in.Phone, in.Email = clip(in.Name, 200), clip(in.Phone, 30), clip(in.Email, 100)
	if in.Name == "" {
		fail(w, 400, "Не указан преподаватель")
		return
	}
	var okVK, okTG bool
	in.VK, okVK = profile(in.VK, vkRe, vkOk)
	in.TG, okTG = profile(in.TG, tgRe, tgOk)
	if !okVK || !okTG {
		fail(w, 400, "ВК и Telegram — ссылка на профиль или имя (@name)")
		return
	}
	var err error
	if in.Phone == "" && in.Email == "" && in.VK == "" && in.TG == "" {
		_, err = db.Exec("DELETE FROM teachers WHERE name = ?", in.Name)
	} else {
		_, err = db.Exec(`INSERT INTO teachers (name, phone, email, vk, tg) VALUES (?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE phone = VALUES(phone), email = VALUES(email), vk = VALUES(vk), tg = VALUES(tg)`,
			in.Name, in.Phone, in.Email, in.VK, in.TG)
	}
	if !serverErr(w, err) {
		respondOK(w)
	}
}

// ---------- Общие материалы ----------

// Material — общий материал; Date — его слот ДЗ (пара 0), где лежат описание и файлы.
type Material struct {
	ID    int64  `db:"id" json:"id"`
	Title string `db:"title" json:"title"`
	Date  string `db:"date" json:"date"`
}

const materialCols = "id, title, DATE_FORMAT(DATE_ADD('" + generalDate + "', INTERVAL id DAY), '%Y-%m-%d') AS date"

// listMaterials — все общие материалы, новые сверху.
func listMaterials(w http.ResponseWriter, r *http.Request) {
	list := []Material{}
	if !serverErr(w, db.Select(&list, "SELECT "+materialCols+" FROM materials ORDER BY id DESC")) {
		writeJSON(w, 200, list)
	}
}

// createMaterial добавляет общий материал с названием (до 200 символов).
func createMaterial(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title string `json:"title"`
	}
	if !decode(w, r, &in) {
		return
	}
	title := clip(in.Title, 200)
	if title == "" {
		fail(w, 400, "Нужно название")
		return
	}
	res, err := db.Exec("INSERT INTO materials (title, created_by) VALUES (?, ?)", title, userOf(r).ID)
	if serverErr(w, err) {
		return
	}
	id, _ := res.LastInsertId()
	var m Material
	if !serverErr(w, db.Get(&m, "SELECT "+materialCols+" FROM materials WHERE id = ?", id)) {
		writeJSON(w, 200, m)
	}
}

// deleteMaterial удаляет материал вместе с его описанием и файлами (и с диска).
func deleteMaterial(w http.ResponseWriter, r *http.Request) {
	var m Material
	err := db.Get(&m, "SELECT "+materialCols+" FROM materials WHERE id = ?", r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		respondOK(w)
		return
	}
	if serverErr(w, err) {
		return
	}
	var stored []string
	err = db.Select(&stored, "SELECT stored_name FROM homework_files WHERE date = ?", m.Date)
	for _, q := range []string{"homework_files", "homework"} {
		if err != nil {
			break
		}
		_, err = db.Exec("DELETE FROM "+q+" WHERE date = ?", m.Date)
	}
	if err == nil {
		_, err = db.Exec("DELETE FROM materials WHERE id = ?", m.ID)
	}
	for _, name := range stored {
		if err != nil {
			break
		}
		err = removeUnused(name)
	}
	if !serverErr(w, err) {
		respondOK(w)
	}
}

// ---------- Админка ----------

// Invite — инвайт-ключ; UsedBy — имена тех, кто по нему зарегистрировался.
type Invite struct {
	Code      string    `db:"code" json:"code"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
	MaxUses   int       `db:"max_uses" json:"max_uses"`
	UsedCount int       `db:"used_count" json:"used_count"`
	UsedBy    []string  `db:"-" json:"used_by"`
}

// listInvites — все ключи с именами зарегистрировавшихся по ним.
func listInvites(w http.ResponseWriter, r *http.Request) {
	invites := []Invite{}
	var users []struct {
		Code string `db:"invite_code"`
		Name string `db:"name"`
	}
	err := errors.Join(
		db.Select(&invites, "SELECT code, created_at, max_uses, used_count FROM invites ORDER BY created_at DESC"),
		db.Select(&users, "SELECT invite_code, COALESCE("+displayNameSQL("")+", '') AS name FROM users WHERE invite_code IS NOT NULL ORDER BY id"),
	)
	if serverErr(w, err) {
		return
	}
	for i := range invites {
		invites[i].UsedBy = []string{}
		for _, u := range users {
			if u.Code == invites[i].Code {
				invites[i].UsedBy = append(invites[i].UsedBy, u.Name)
			}
		}
	}
	writeJSON(w, 200, invites)
}

// createInvite генерирует случайный ключ на max_uses использований (1–1000).
func createInvite(w http.ResponseWriter, r *http.Request) {
	var in struct {
		MaxUses *int `json:"max_uses"`
	}
	if !decode(w, r, &in) {
		return
	}
	maxUses := 1
	if in.MaxUses != nil {
		maxUses = *in.MaxUses
	}
	if maxUses < 1 || maxUses > 1000 {
		fail(w, 400, "Количество использований: от 1 до 1000")
		return
	}
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	for range 10 {
		code := make([]byte, 6)
		rand.Read(code)
		for i := range code {
			code[i] = alphabet[int(code[i])%len(alphabet)]
		}
		_, err := db.Exec("INSERT INTO invites (code, created_by, max_uses) VALUES (?, ?, ?)", string(code), userOf(r).ID, maxUses)
		var me *mysql.MySQLError
		if errors.As(err, &me) && me.Number == 1062 { // такой код уже есть — пробуем другой
			continue
		}
		if !serverErr(w, err) {
			writeJSON(w, 200, map[string]any{"code": string(code), "max_uses": maxUses})
		}
		return
	}
	fail(w, 500, "Не удалось сгенерировать ключ")
}

// deleteInvite отзывает ключ.
func deleteInvite(w http.ResponseWriter, r *http.Request) {
	_, err := db.Exec("DELETE FROM invites WHERE code = ?", r.PathValue("code"))
	if !serverErr(w, err) {
		respondOK(w)
	}
}

// targetUser: id и роль пользователя, над которым совершают действие; при ошибке сам отвечает и возвращает false.
func targetUser(w http.ResponseWriter, r *http.Request) (id int64, role string, found bool) {
	var t struct {
		ID   int64  `db:"id"`
		Role string `db:"role"`
	}
	err := db.Get(&t, "SELECT id, role FROM users WHERE id = ?", r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "Не найдено")
		return 0, "", false
	}
	if serverErr(w, err) {
		return 0, "", false
	}
	return t.ID, t.Role, true
}

// setRole назначает роль (студент, модератор, админ); только главный админ, самого главного менять нельзя.
func setRole(w http.ResponseWriter, r *http.Request) {
	if userOf(r).Role != "owner" {
		fail(w, 403, "Только главный админ")
		return
	}
	var in struct {
		Role string `json:"role"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Role != "student" && in.Role != "moderator" && in.Role != "admin" {
		fail(w, 400, "role")
		return
	}
	id, role, found := targetUser(w, r)
	if !found {
		return
	}
	if role == "owner" {
		fail(w, 403, "Главного админа менять нельзя")
		return
	}
	if _, err := db.Exec("UPDATE users SET role = ? WHERE id = ?", in.Role, id); !serverErr(w, err) {
		respondOK(w)
	}
}

// deleteUser удаляет пользователя: админа — только главный админ, главного — никто.
func deleteUser(w http.ResponseWriter, r *http.Request) {
	id, role, found := targetUser(w, r)
	if !found {
		return
	}
	switch {
	case role == "owner":
		fail(w, 403, "Главного админа удалить нельзя")
	case role == "admin" && userOf(r).Role != "owner":
		fail(w, 403, "Админа удаляет только главный админ")
	default:
		if _, err := db.Exec("DELETE FROM users WHERE id = ?", id); !serverErr(w, err) {
			respondOK(w)
		}
	}
}

// Расписание сохраняется целиком: старые пары удаляются, присланные записываются заново.
func saveSchedule(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Lessons []Lesson `json:"lessons"`
	}
	if !decode(w, r, &in) {
		return
	}
	if len(in.Lessons) > 300 {
		fail(w, 400, "lessons")
		return
	}
	for i, l := range in.Lessons {
		l.Subject = clip(l.Subject, 200)
		if l.Weekday < 1 || l.Weekday > 6 || l.PairNo < 1 || l.PairNo > 10 || l.Subject == "" {
			fail(w, 400, "Некорректная пара")
			return
		}
		if l.Parity != "odd" && l.Parity != "even" {
			l.Parity = "all"
		}
		l.Teacher, l.Room, l.Kind = clip(l.Teacher, 200), clip(l.Room, 50), clip(l.Kind, 30)
		in.Lessons[i] = l
	}
	tx, err := db.Beginx()
	if serverErr(w, err) {
		return
	}
	defer tx.Rollback()
	_, err = tx.Exec("DELETE FROM lessons")
	for _, l := range in.Lessons {
		if err != nil {
			break
		}
		_, err = tx.Exec("INSERT INTO lessons (weekday, pair_no, parity, subject, teacher, room, kind, remote) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			l.Weekday, l.PairNo, l.Parity, l.Subject, l.Teacher, l.Room, l.Kind, l.Remote)
	}
	if err == nil {
		err = tx.Commit()
	}
	if !serverErr(w, err) {
		respondOK(w)
	}
}

// saveWeek сохраняет замены на неделю [from, to] целиком: старые замены в диапазоне удаляются, присланные записываются.
func saveWeek(w http.ResponseWriter, r *http.Request) {
	var in struct {
		From    string         `json:"from"`
		To      string         `json:"to"`
		Changes []LessonChange `json:"changes"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validDate(in.From) || !validDate(in.To) || len(in.Changes) > 100 {
		fail(w, 400, "Некорректная неделя")
		return
	}
	for i, c := range in.Changes {
		if !validDate(c.Date) || c.Date < in.From || c.Date > in.To || c.PairNo < 1 || c.PairNo > 10 {
			fail(w, 400, "Некорректная пара")
			return
		}
		c.Subject, c.Teacher, c.Room, c.Kind = clip(c.Subject, 200), clip(c.Teacher, 200), clip(c.Room, 50), clip(c.Kind, 30)
		in.Changes[i] = c
	}
	tx, err := db.Beginx()
	if serverErr(w, err) {
		return
	}
	defer tx.Rollback()
	_, err = tx.Exec("DELETE FROM lesson_changes WHERE date BETWEEN ? AND ?", in.From, in.To)
	for _, c := range in.Changes {
		if err != nil {
			break
		}
		_, err = tx.Exec("REPLACE INTO lesson_changes (date, pair_no, subject, teacher, room, kind, remote) VALUES (?, ?, ?, ?, ?, ?, ?)",
			c.Date, c.PairNo, c.Subject, c.Teacher, c.Room, c.Kind, c.Remote)
	}
	if err == nil {
		err = tx.Commit()
	}
	if !serverErr(w, err) {
		respondOK(w)
	}
}

// savePairTimes сохраняет время пар целиком: n-й элемент списка — n-я пара.
func savePairTimes(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Times []PairTime `json:"times"`
	}
	if !decode(w, r, &in) {
		return
	}
	if len(in.Times) > 10 {
		fail(w, 400, "times")
		return
	}
	for _, t := range in.Times {
		if !timeRe.MatchString(t.Start) || !timeRe.MatchString(t.End) {
			fail(w, 400, "Время в формате ЧЧ:ММ")
			return
		}
	}
	tx, err := db.Beginx()
	if serverErr(w, err) {
		return
	}
	defer tx.Rollback()
	_, err = tx.Exec("DELETE FROM pair_times")
	for i, t := range in.Times {
		if err != nil {
			break
		}
		_, err = tx.Exec("INSERT INTO pair_times (pair_no, start_time, end_time) VALUES (?, ?, ?)", i+1, t.Start, t.End)
	}
	if err == nil {
		err = tx.Commit()
	}
	if !serverErr(w, err) {
		respondOK(w)
	}
}

// saveSettings сохраняет дату начала семестра.
func saveSettings(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SemesterStart string `json:"semester_start"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validDate(in.SemesterStart) {
		fail(w, 400, "Дата ГГГГ-ММ-ДД")
		return
	}
	_, err := db.Exec("INSERT INTO settings (k, v) VALUES ('semester_start', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", in.SemesterStart)
	if !serverErr(w, err) {
		respondOK(w)
	}
}
