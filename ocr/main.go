// Сервис распознавания листа замен (скан/фото таблицы «группы × пары») по всем группам —
// отдельный контейнер (Dockerfile.ocr), чтобы tesseract не делил память с сайтом.
// Сетка, цвета и нарезка ячеек — стандартная библиотека, текст ячеек — программа tesseract
// (локально: brew install tesseract tesseract-lang). Модель tessdata_best/rus.traineddata — в TESSDATA_DIR (по умолчанию ./tessdata).
//
//	POST /parse  (тело — JPG или PNG) → {title, groups, ms}
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/jpeg"
	"image/png"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
)

type OcrPair struct {
	Pair    int    `json:"pair"`
	Room    string `json:"room"`
	Subject string `json:"subject"`
	Teacher string `json:"teacher"`
	Changed bool   `json:"changed"` // жёлтая заливка
	Moved   bool   `json:"moved"`   // зелёная метка «N ПАРА»: номер пары не совпадает с колонкой
	Raw     string `json:"raw"`
}

type OcrGroup struct {
	Name  string    `json:"group"`
	Pairs []OcrPair `json:"pairs"`
}

const colsPerBlock = 6 // группа + 5 пар; лист — одинаковые блоки слева направо

// процессов tesseract одновременно: каждый с моделью best занимает ~90 МБ памяти
const procs = 2

// один лист за раз: второй ждёт, пока распознаётся первый
var mu sync.Mutex

var tessdata = env("TESSDATA_DIR", "tessdata")

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	if _, err := exec.LookPath("tesseract"); err != nil {
		log.Fatal("нет программы tesseract (brew install tesseract tesseract-lang)")
	}
	http.HandleFunc("POST /parse", parse)
	port := env("PORT", "3001")
	log.Printf("kkmt-ocr слушает :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func parse(w http.ResponseWriter, r *http.Request) {
	img, _, err := image.Decode(http.MaxBytesReader(w, r.Body, 20<<20))
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "Не удалось прочитать картинку (нужен JPG или PNG до 20 МБ)"})
		return
	}
	mu.Lock()
	defer mu.Unlock()
	// Ответ — строки JSON по мере работы: {"done","total"} после каждой ячейки, последней — результат или {"error"}.
	// Код 200 уходит с первой строкой, поэтому ошибка распознавания — тоже строкой.
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	rc, enc := http.NewResponseController(w), json.NewEncoder(w)
	var wmu sync.Mutex // ячейки дочитывают несколько процессов одновременно
	line := func(v any) {
		wmu.Lock()
		defer wmu.Unlock()
		enc.Encode(v)
		rc.Flush()
	}
	start := time.Now()
	title, groups, err := parseSheet(img, func(done, total int) { line(map[string]int{"done": done, "total": total}) })
	if err != nil {
		line(map[string]string{"error": err.Error()})
		return
	}
	line(map[string]any{"title": title, "groups": groups, "ms": time.Since(start).Milliseconds()})
}

// ячейка таблицы: строка, колонка и прямоугольник без рамки
type ocrCell struct {
	row, col int
	r        image.Rectangle
}

// progress вызывается после каждой распознанной ячейки
func parseSheet(img image.Image, progress func(done, total int)) (string, []OcrGroup, error) {
	ys, xs := gridLines(img, true), gridLines(img, false)
	if len(ys) < 3 || len(xs)-1 < colsPerBlock {
		return "", nil, errors.New("Не нашлась таблица: нужен ровный скан или фото листа без перекоса")
	}
	inner := func(row, col int) image.Rectangle { // отступ внутрь, чтобы рамка не попала в OCR
		return image.Rect(xs[col]+5, ys[row]+5, xs[col+1]-4, ys[row+1]-4)
	}

	// заголовок листа над таблицей и все непустые ячейки, кроме строки «1 пара …»
	jobs := []ocrCell{{-1, -1, image.Rect(xs[0], 0, xs[len(xs)-1], ys[0])}}
	for row := 1; row+1 < len(ys); row++ {
		for col := 0; col+1 < len(xs); col++ {
			if colorShare(img, inner(row, col), dark) > 0.002 {
				jobs = append(jobs, ocrCell{row, col, inner(row, col)})
			}
		}
	}
	texts, err := ocr(img, jobs, progress)
	if err != nil {
		return "", nil, err
	}
	text := map[[2]int]string{}
	for i, j := range jobs {
		text[[2]int{j.row, j.col}] = texts[i]
	}

	groups := []OcrGroup{}
	for gc := 0; gc+colsPerBlock < len(xs); gc += colsPerBlock {
		for row := 1; row+1 < len(ys); row++ {
			name := fixGroup(text[[2]int{row, gc}])
			if name == "" {
				continue
			}
			g := OcrGroup{Name: name, Pairs: []OcrPair{}}
			for k := 1; k < colsPerBlock; k++ {
				raw := text[[2]int{row, gc + k}]
				if raw == "" {
					continue
				}
				// зелёная метка «N ПАРА» над текстом ячейки: пара стоит не в своей колонке
				marked := colorShare(img, inner(row, gc+k), isGreen) > 0.02
				p := parseCell(raw, marked)
				switch {
				case !marked:
					p.Pair = k
				case p.Pair == 0: // номер на метке не прочитался — на таких листах метка сдвигает на одну пару
					p.Pair = k + 1
				}
				p.Moved = p.Pair != k
				p.Changed = colorShare(img, inner(row, gc+k), isYellow) > 0.3
				g.Pairs = append(g.Pairs, p)
			}
			groups = append(groups, g)
		}
	}
	return strings.Join(strings.Fields(texts[0]), " "), groups, nil
}

// gridLines — координаты линий таблицы: строки (или столбцы) пикселей, где тёмная полоса тянется больше чем на половину листа.
// Соседние такие строки (толстая линия) сливаются в одну, берётся середина.
func gridLines(img image.Image, horizontal bool) []int {
	b := img.Bounds()
	n, m := b.Dy(), b.Dx() // n — сколько линий-кандидатов, m — их длина
	if !horizontal {
		n, m = m, n
	}
	var res []int
	from := -1
	for i := 0; i <= n; i++ {
		long := false
		if i < n {
			run, best := 0, 0
			for j := 0; j < m; j++ {
				x, y := b.Min.X+j, b.Min.Y+i
				if !horizontal {
					x, y = b.Min.X+i, b.Min.Y+j
				}
				if dark(img.At(x, y)) {
					run++
					best = max(best, run)
				} else {
					run = 0
				}
			}
			long = best > m/2
		}
		switch {
		case long && from < 0:
			from = i
		case !long && from >= 0:
			res = append(res, (from+i-1)/2)
			from = -1
		}
	}
	return res
}

func rgb(c color.Color) (int, int, int) {
	r, g, b, _ := c.RGBA()
	return int(r >> 8), int(g >> 8), int(b >> 8)
}

// dark — чернила: все каналы тёмные. Зелёная и жёлтая заливка сюда не попадают (у них яркий зелёный канал).
func dark(c color.Color) bool {
	r, g, b := rgb(c)
	return max(r, g, b) < 140
}

func isGreen(c color.Color) bool {
	r, g, b := rgb(c)
	return g > 150 && g-r > 60 && g-b > 60
}

func isYellow(c color.Color) bool {
	r, g, b := rgb(c)
	return r > 200 && g > 200 && b < 140
}

func colorShare(img image.Image, r image.Rectangle, is func(color.Color) bool) float64 {
	n := 0
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			if is(img.At(x, y)) {
				n++
			}
		}
	}
	return float64(n) / float64(max(1, r.Dx()*r.Dy()))
}

// cellImage — ячейка для OCR: увеличена в 2 раза (tesseract лучше читает крупные буквы),
// только чернила — чёрным, всё остальное (в т.ч. цветная заливка) — белым, с белыми полями.
func cellImage(img image.Image, r image.Rectangle) *image.Gray {
	const scale, pad = 2, 16
	w, h := r.Dx()*scale, r.Dy()*scale
	out := image.NewGray(image.Rect(0, 0, w+2*pad, h+2*pad))
	for i := range out.Pix {
		out.Pix[i] = 255
	}
	v := func(x, y int) float64 {
		rr, g, b := rgb(img.At(r.Min.X+min(x, r.Dx()-1), r.Min.Y+min(y, r.Dy()-1)))
		return float64(max(rr, g, b))
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			// билинейное увеличение, потом порог — края букв гладкие
			fx, fy := float64(x)/scale, float64(y)/scale
			x0, y0 := int(fx), int(fy)
			dx, dy := fx-float64(x0), fy-float64(y0)
			l := v(x0, y0)*(1-dx)*(1-dy) + v(x0+1, y0)*dx*(1-dy) + v(x0, y0+1)*(1-dx)*dy + v(x0+1, y0+1)*dx*dy
			if l < 140 {
				out.Pix[(y+pad)*out.Stride+x+pad] = 0
			}
		}
	}
	return out
}

// ocr читает все ячейки: картинки пишутся во временную папку, а tesseract получает список файлов —
// модель загружается один раз на процесс; ячейки делятся между procs процессами.
func ocr(img image.Image, jobs []ocrCell, progress func(done, total int)) ([]string, error) {
	dir, err := os.MkdirTemp("", "kkmt-ocr")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	paths := make([]string, len(jobs))
	for i, j := range jobs {
		var buf bytes.Buffer
		png.Encode(&buf, cellImage(img, j.r))
		paths[i] = filepath.Join(dir, fmt.Sprintf("%04d.png", i))
		if err := os.WriteFile(paths[i], buf.Bytes(), 0o644); err != nil {
			return nil, err
		}
	}
	args := []string{"-l", "rus", "--psm", "6"}
	if _, err := os.Stat(filepath.Join(tessdata, "rus.traineddata")); err == nil {
		args = append(args, "--tessdata-dir", tessdata)
	}

	texts := make([]string, len(jobs))
	chunk := (len(jobs) + procs - 1) / procs
	errs := make([]error, procs)
	var done atomic.Int32
	var wg sync.WaitGroup
	for p := 0; p*chunk < len(jobs); p++ {
		from, to := p*chunk, min((p+1)*chunk, len(jobs))
		wg.Add(1)
		go func() {
			defer wg.Done()
			list := filepath.Join(dir, fmt.Sprintf("list%d.txt", p))
			if errs[p] = os.WriteFile(list, []byte(strings.Join(paths[from:to], "\n")+"\n"), 0o644); errs[p] != nil {
				return
			}
			cmd := exec.Command("tesseract", append([]string{list, "stdout"}, args...)...)
			cmd.Env = append(os.Environ(), "OMP_THREAD_LIMIT=1") // параллелим процессами, а не потоками внутри
			out, err := cmd.StdoutPipe()
			if err == nil {
				err = cmd.Start()
			}
			if err != nil {
				errs[p] = fmt.Errorf("tesseract: %w", err)
				return
			}
			// tesseract пишет ячейку сразу, как распознал; ячейки разделены символом \f (после последней его нет)
			rd := bufio.NewReader(out)
			for i := from; i < to; i++ {
				page, err := rd.ReadString('\f')
				texts[i] = strings.TrimSpace(strings.TrimSuffix(page, "\f"))
				progress(int(done.Add(1)), len(jobs))
				if err != nil {
					break
				}
			}
			if err := cmd.Wait(); err != nil {
				errs[p] = fmt.Errorf("tesseract: %w", err)
			}
		}()
	}
	wg.Wait()
	return texts, errors.Join(errs...)
}

// Исправления типичных ошибок OCR на этом листе: в номерах буквы О/З вместо 0/3, «б» читается как «6».
var (
	toDigits  = strings.NewReplacer("О", "0", "о", "0", "O", "0", "o", "0", "З", "3", "з", "3", "|", "1", "l", "1", " ", "")
	digitRe   = regexp.MustCompile(`\d`)
	placeRe   = regexp.MustCompile(`(?i)^(АУ\s?Д|СПОРТЗАЛ|ВЫМПЕЛ|УЛ\.)`)
	roomRe    = regexp.MustCompile(`(?i)^АУ\s?ДИ?\S*?[.,]\s*`)
	codeRe    = regexp.MustCompile(`(МДК|УП|ПП|ПМ)[\s.,]*([\dОоOoЗз]{2})[.,]\s*([\dОоOoЗз]{2})`)
	initialRe = regexp.MustCompile(`^[А-ЯЁа-яё]{1,2}\.?$|^[А-ЯЁ]\.\s?[А-ЯЁ]?\.?$`)
	teacherRe = regexp.MustCompile(`^[А-ЯЁ][А-ЯЁа-яё-]+\s+([А-ЯЁа-яё]{1,2}\.?|[А-ЯЁ]\.\s?[А-ЯЁ]?\.?)$`)
)

// fixGroup: «ТМ1-\n24» → «ТМ1-24»; после дефиса только цифры; «БТСЗ» → «БТС3».
// Группа всегда начинается с буквы: крупные жирные «П»/«О» OCR читает как 1/0 («11-24» → «П1-24»).
func fixGroup(s string) string {
	s = strings.Join(strings.FieldsFunc(s, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '-' }), "")
	i := strings.LastIndex(s, "-")
	if i <= 0 {
		return s
	}
	head, year := s[:i], toDigits.Replace(s[i+1:])
	if strings.HasSuffix(head, "З") {
		head = strings.TrimSuffix(head, "З") + "3"
	}
	if len(head) >= 2 && strings.Trim(head, "0123456789") == "" {
		letter := "П"
		if head[0] == '0' {
			letter = "О"
		}
		head = letter + head[len(head)-1:]
	}
	return head + "-" + year
}

// fixRoom: «АУДИТ, 2026/1» → «202б/1»; места без номера («СПОРТЗАЛ», «ул.Гагарина, 42 …») — как есть.
func fixRoom(s string) string {
	if !roomRe.MatchString(s) {
		return s
	}
	n := toDigits.Replace(strings.ReplaceAll(roomRe.ReplaceAllString(s, ""), ":", "/"))
	// аудитории — 3 цифры и буква: четвёртая «6» — это «б»
	if len(n) >= 4 && n[3] == '6' && strings.Trim(n[:3], "0123456789") == "" {
		n = n[:3] + "б" + n[4:]
	}
	return n
}

// parseCell: «[N ПАРА] / место / предмет / преподаватель» из строк, которые вернул OCR.
// marked — в ячейке зелёная метка: первая строка — «N ПАРА», из неё берём только цифру.
func parseCell(raw string, marked bool) OcrPair {
	p := OcrPair{Raw: raw}
	var ls []string
	for _, l := range strings.Split(raw, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			ls = append(ls, l)
		}
	}
	if marked && len(ls) > 0 {
		if m := digitRe.FindString(ls[0]); m != "" {
			p.Pair, _ = strconv.Atoi(m)
		}
		ls = ls[1:]
	}
	// место: «АУД.203», «СПОРТЗАЛ», «ул.Гагарина, 42» + «АУД.1303» (другой корпус)
	var place []string
	for len(ls) > 0 && placeRe.MatchString(ls[0]) {
		place = append(place, fixRoom(ls[0]))
		ls = ls[1:]
	}
	p.Room = strings.Join(place, ", ")
	// инициалы, перенесённые на отдельную строку («Синицын» / «КА»), приклеиваем к фамилии
	if n := len(ls); n >= 2 && initialRe.MatchString(ls[n-1]) {
		ls = append(ls[:n-2], ls[n-2]+" "+ls[n-1])
	}
	if n := len(ls); n >= 2 && teacherRe.MatchString(ls[n-1]) {
		f := strings.Fields(ls[n-1])
		p.Teacher = strings.Join(f[:len(f)-1], " ") + " " + strings.ToUpper(f[len(f)-1])
		ls = ls[:n-1]
	}
	p.Subject = codeRe.ReplaceAllStringFunc(strings.Join(ls, " "), func(c string) string {
		m := codeRe.FindStringSubmatch(c)
		return m[1] + " " + toDigits.Replace(m[2]) + "." + toDigits.Replace(m[3])
	})
	return p
}
