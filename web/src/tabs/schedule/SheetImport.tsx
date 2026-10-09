import { useCallback, useEffect, useRef, useState } from 'react';
import { api, cached, errText } from '../../lib/api';
import { IcoScan } from '../../components/icons';
import { useConfirm } from '../../components/Dialog';
import { weekNumber, type Lesson, type LessonChange, type Teacher } from '.';
import './sheet.css';

interface OcrPair { pair: number; room: string; subject: string; teacher: string; changed: boolean; moved: boolean; raw: string }
interface OcrGroup { group: string; pairs: OcrPair[] }
interface Result { title: string; groups: OcrGroup[]; ms: number }
interface Sched { lessons: Lesson[]; changes?: LessonChange[]; teachers?: Teacher[]; semesterStart: string | null }

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
// Бюджет на ошибки OCR: сколько букв в слове может быть прочитано неверно, чтобы слово всё ещё считалось совпадением.
// Сверху ещё ограничение «не больше трети слова» — иначе короткие слова совпадут с чем угодно.
const BUDGET_KEY = 'kkmt.ocrBudget';
const allowed = (budget: number, word: string) => Math.min(budget, Math.max(1, Math.floor(word.length / 3)));
// Самое похожее слово из списка (OCR путает буквы: «октяоря» → «октября»)
const closest = (w: string, list: string[], budget: number) => {
    const d = list.map(x => dist(w, x));
    const i = d.indexOf(Math.min(...d));
    return d[i] <= allowed(budget, list[i]) ? i : -1;
};
// в числах OCR ставит похожие буквы: «О9», «2О2б»
const digits = (s: string) => s.replace(/[ОоOo]/g, '0').replace(/[Зз]/g, '3').replace(/[lI|]/g, '1').replace(/б/g, '6');

// Заголовок листа «Пятница, 09 октября 2026г., знаменатель» → дата, день недели (индекс, пн = 0) и «числитель/знаменатель»
function parseTitle(t: string, budget: number) {
    const words = norm(t).split(/[^0-9а-яa-z|]+/).filter(Boolean);
    let date = '';
    for (let i = 0; i + 2 < words.length && !date; i++) {
        const mon = closest(words[i + 1], MONTHS, budget);
        const day = Number(digits(words[i])), year = Number(digits(words[i + 2]).replace(/\D.*$/, ''));
        if (mon >= 0 && day >= 1 && day <= 31 && year >= 2000 && year < 2100)
            date = `${year}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    const weekday = words.map(w => closest(w, WEEKDAYS, budget)).find(i => i >= 0) ?? -1;
    const kind = words.map(w => closest(w, ['числитель', 'знаменатель'], budget)).find(i => i >= 0);
    return { date, weekday, parity: kind === undefined ? '' : ['числитель', 'знаменатель'][kind] };
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
function dist(a: string, b: string) {
    const d = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let prev = d[0]; d[0] = i;
        for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
    }
    return d[b.length];
}
const initials = (s: string) => s.split(/\s+/).slice(1).join('').replace(/[^А-ЯЁ]/g, '');

// найденное в расписании и сколько ошибок OCR на это ушло
interface Match { name: string; cost: number }

// Преподаватель из расписания: ошибки в фамилии плюс 1, если не совпала первая буква инициалов (когда она прочиталась)
function matchTeacher(ocr: string, names: string[], budget: number): Match | undefined {
    const [sur] = norm(ocr).split(/\s+/);
    const ini = initials(ocr);
    let best: Match | undefined;
    for (const n of names) {
        const cost = dist(sur, norm(n).split(/\s+/)[0]) + (ini && initials(n) && ini[0] !== initials(n)[0] ? 1 : 0);
        if (!best || cost < best.cost) best = { name: n, cost };
    }
    return sur && best && best.cost <= allowed(budget, sur) ? best : undefined;
}

// Предмет из расписания: по коду («МДК 01.01») или по сокращению («Комп.сети» → «Компьютерные сети»):
// каждая часть сокращения — начало очередного слова названия (с одной опечаткой), или аббревиатура («ОПБД»);
// плюс — если предмет ведёт найденный преподаватель
function matchSubject(ocr: string, lessons: Lesson[], budget: number, teacher?: string): Match | undefined {
    const code = ocr.match(/(МДК|УП|ПП|ПМ)\s?\d\d\.\d\d/)?.[0].replace(/\s/, ' ');
    const parts = norm(ocr).split(/[\s.,-]+/).filter(Boolean);
    const abbr = /^[А-ЯЁ]{2,6}$/.test(ocr.trim()) ? norm(ocr.trim()) : '';
    let best: Match | undefined, bestScore = 0;
    for (const s of new Set(lessons.map(l => l.subject))) {
        let score: number, cost = 0;
        if (code) score = s.replace(/^(МДК|УП|ПП|ПМ)[\s.]?/, '$1 ').startsWith(code) ? 1 : 0;
        else if (abbr) {
            cost = dist(abbr, norm(s).split(/[\s,]+/).filter(x => x.length > 1).map(x => x[0]).join(''));
            score = cost <= allowed(budget, abbr) ? 1 : 0;
        }
        else {
            const words = norm(s).split(/[\s,]+/);
            // часть сокращения в 1 букву — точное начало слова, длиннее — с ошибками в пределах бюджета;
            // не найденная часть тоже стоит 1 ошибку
            let w = 0, hit = 0, all = 0;
            for (const p of parts) {
                all += p.length;
                const d = words.slice(w).map(x => p.length < 2 ? (x.startsWith(p) ? 0 : Infinity) : dist(p, x.slice(0, p.length)));
                const k = d.findIndex(x => x <= allowed(budget, p));
                if (k >= 0) { hit += p.length; w += k + 1; cost += d[k]; } else cost++;
            }
            score = all ? hit / all : 0;
        }
        if (teacher && lessons.some(l => l.subject === s && l.teacher === teacher)) score += 0.3;
        if (score > bestScore || (score === bestScore && best && cost < best.cost)) { best = { name: s, cost }; bestScore = score; }
    }
    return bestScore >= 0.6 ? best : undefined;
}

const roomKey = (r: string) => norm(r).replace(/[^0-9а-яa-z/]/g, '');
// похоже на номер кабинета: «303», «106б», «202б/1»; места без цифр («СПОРТЗАЛ») и адреса другого корпуса — тоже
const roomOk = (r: string) => /^\d{3}[а-яa-z]?(\/\d)?$/i.test(roomKey(r)) || !/\d/.test(r) || /ул/i.test(r);
// Кабинет на листе против расписания: same — тот же, cost — сколько ошибок OCR простили, bad — номер не распознан.
// Лишнюю или потерянную цифру прощаем только у номера, который не похож на номер («3303»): иначе спрятали бы настоящую замену 303 → 313.
function roomMatch(ocr: string, base: string, budget: number) {
    if (roomKey(ocr) === roomKey(base)) return { same: true, cost: 0, bad: false };
    if (roomOk(ocr)) return { same: false, cost: 0, bad: false };
    const d = dist(roomKey(ocr), roomKey(base));
    return d <= Math.min(budget, 1) ? { same: true, cost: d, bad: false } : { same: false, cost: 0, bad: true };
}

// сколько ошибок OCR пришлось простить ради совпадения
const Cost = ({ n }: { n: number }) => n > 0 ? <span className="ocr-cost" title="Столько букв пришлось исправить, чтобы найти совпадение"> · {n} {n === 1 ? 'ошибка' : n < 5 ? 'ошибки' : 'ошибок'}</span> : null;

// Память исправлений: как OCR прочитал → что это на самом деле (подтверждено модератором при сохранении)
export interface Alias { kind: 'subject' | 'teacher' | 'room'; ocr: string; value: string }
const aliasKey = (s: string) => norm(s).replace(/\s+/g, ' ').trim();
type Final = { subject: string; teacher: string; room: string };

// Сверка строки своей группы с постоянным расписанием на дату листа. Итог каждой пары можно поправить;
// «Сохранить в замены» записывает отличия от расписания как замены на эту дату и запоминает подтверждённые исправления.
function Compare({ row, sched, date, budget, aliases, showMsg, onSaved }: {
    row: OcrGroup; sched: Sched; date: string; budget: number; aliases: Alias[]; showMsg: (t: string) => void; onSaved: () => void;
}) {
    const [edits, setEdits] = useState<Record<number, Partial<Final>>>({});
    const [busy, setBusy] = useState(false);
    const [ask, dialog] = useConfirm();
    const d = new Date(`${date}T00:00:00`);
    const parity = weekNumber(d, sched.semesterStart) % 2 === 1 ? 'odd' : 'even';
    const base = sched.lessons.filter(l => l.weekday === (d.getDay() + 6) % 7 + 1 && (l.parity === 'all' || l.parity === parity));
    const names = [...new Set([...sched.lessons.map(l => l.teacher), ...(sched.teachers ?? []).map(t => t.name)].filter(Boolean))].sort();
    const subjects = [...new Set(sched.lessons.map(l => l.subject))].sort();
    const nums = [...new Set([...base.map(l => l.pair_no), ...row.pairs.map(p => p.pair)])].sort((a, b) => a - b);
    const remembered = (kind: Alias['kind'], ocr: string) => aliases.find(a => a.kind === kind && a.ocr === aliasKey(ocr))?.value;

    const rows = nums.map(n => {
        const b = base.find(l => l.pair_no === n);
        const p = row.pairs.find(x => x.pair === n);
        // сначала память исправлений, потом нечёткий поиск
        const memT = p && remembered('teacher', p.teacher), memS = p && remembered('subject', p.subject), memR = p && remembered('room', p.room);
        const tm = memT ? { name: memT, cost: 0 } : p && matchTeacher(p.teacher, names, budget);
        let sm = memS ? { name: memS, cost: 0 } : p && matchSubject(p.subject, sched.lessons, budget, tm?.name);
        // предмет не распознан, но преподаватель тот же, что по расписанию, — значит, и предмет тот же
        const byTeacher = !sm && !!b && !!tm && tm.name === b.teacher;
        if (byTeacher) sm = { name: b.subject, cost: 0 };
        const rm = p && b && !memR ? roomMatch(p.room, b.room, budget) : undefined;
        const auto: Final = !p ? { subject: '', teacher: '', room: '' }
            : { subject: sm?.name ?? p.subject, teacher: tm?.name ?? p.teacher, room: memR ?? (rm?.same ? b!.room : p.room) };
        const f = { ...auto, ...edits[n] };
        const same = !!b && f.subject === b.subject && f.teacher === b.teacher && roomKey(f.room) === roomKey(b.room);
        const verdict = !f.subject ? (b ? 'Пары нет' : '') : !b ? 'Новая пара' : same ? 'Без изменений'
            : `Замена: ${[f.subject !== b.subject && 'предмет', f.teacher !== b.teacher && 'преподаватель', roomKey(f.room) !== roomKey(b.room) && `кабинет ${b.room || '—'} → ${f.room || '—'}`].filter(Boolean).join(', ')}`;
        return { n, b, p, f, same, verdict, tm, sm, rm, byTeacher, mem: { t: !!memT, s: !!memS, r: !!memR } };
    }).filter(r => r.b || r.p);
    const unknown = rows.filter(r => r.f.subject && (!subjects.includes(r.f.subject) || (r.f.teacher && !names.includes(r.f.teacher))));
    const set = (n: number, k: keyof Final, v: string) => setEdits(e => ({ ...e, [n]: { ...e[n], [k]: v } }));

    const save = async () => {
        const has = sched.changes?.some(c => c.date === date);
        const body = `${has ? `На ${date.split('-').reverse().join('.')} уже есть замены — они будут заменены этими. ` : ''}${unknown.length ? `Пар с предметом или преподавателем не из расписания: ${unknown.length} — сохранятся как на листе.` : ''}`;
        if ((has || unknown.length) && !await ask({ title: 'Сохранить замены?', body, confirm: 'Сохранить' })) return;
        const changes = rows.filter(r => !r.same && (r.b || r.f.subject)).map(({ n, b, f }) => ({
            date, pair_no: n, subject: f.subject, teacher: f.subject ? f.teacher : '', room: f.subject ? f.room : '', kind: b?.kind ?? '', remote: b?.remote ?? false,
        }));
        // запоминаем, как OCR прочитал то, что модератор подтвердил
        const memo: Alias[] = rows.flatMap(({ p, f }) => !p || !f.subject ? [] : [
            { kind: 'subject' as const, ocr: aliasKey(p.subject), value: f.subject },
            { kind: 'teacher' as const, ocr: aliasKey(p.teacher), value: f.teacher },
            { kind: 'room' as const, ocr: aliasKey(p.room), value: f.room },
        ].filter(a => a.ocr && a.value && a.ocr !== aliasKey(a.value) && roomKey(a.ocr) !== roomKey(a.value)));
        setBusy(true);
        try {
            await api('PUT', '/admin/schedule/week', { from: date, to: date, changes });
            if (memo.length) await api('PUT', '/admin/ocr/aliases', memo);
            showMsg(changes.length ? `Замен сохранено: ${changes.length}` : 'Замен нет — день как по расписанию');
            onSaved();
        } catch (e) { showMsg(errText(e)); } finally { setBusy(false); }
    };

    const tag = (mem: boolean, cost?: number, extra?: string) => mem ? <span className="ocr-cost"> · из памяти</span> : extra ? <span className="ocr-cost"> · {extra}</span> : <Cost n={cost ?? 0} />;
    return (
        <>
            <div className="ocr-scroll">
                <table className="ocr-table ocr-compare">
                    <thead><tr><th>Пара</th><th>По расписанию</th><th>На листе</th><th>Сохранится</th></tr></thead>
                    <tbody>
                        {rows.map(({ n, b, p, f, verdict, tm, sm, rm, byTeacher, mem }) => (
                            <tr key={n}>
                                <th>{n}<span className="ocr-pair-word"> пара</span>{p?.moved && <span className="hint"> перенос</span>}</th>
                                <td data-label="По расписанию">{b ? <><b>{b.room}</b><span>{b.subject}</span><span className="muted">{b.teacher}</span></> : <span className="muted">—</span>}</td>
                                <td data-label="На листе" className={p?.changed ? 'ocr-changed' : undefined} title={p?.raw}>
                                    {p ? <>
                                        <b>{p.room}{(mem.r || (rm?.same && rm.cost > 0)) && <> → {f.room}{tag(mem.r, rm?.cost)}</>}</b>
                                        <span>{p.subject}{sm ? tag(mem.s, sm.cost, byTeacher ? 'по преподавателю' : '') : <em className="ocr-miss"> · не найден</em>}</span>
                                        <span className="muted">{p.teacher}{tm ? tag(mem.t, tm.cost) : <em className="ocr-miss"> · не найден</em>}</span>
                                    </> : <span className="muted">—</span>}
                                </td>
                                <td data-label="Сохранится"><div className="ocr-final">
                                    <select className={`field${f.subject && !subjects.includes(f.subject) ? ' ocr-bad' : ''}`} value={f.subject} onChange={e => set(n, 'subject', e.target.value)}>
                                        <option value="">— пары нет —</option>
                                        {f.subject && !subjects.includes(f.subject) && <option value={f.subject}>как на листе: {f.subject}</option>}
                                        {subjects.map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                    {f.subject && <>
                                        <select className={`field${f.teacher && !names.includes(f.teacher) ? ' ocr-bad' : ''}`} value={f.teacher} onChange={e => set(n, 'teacher', e.target.value)}>
                                            <option value="">— без преподавателя —</option>
                                            {f.teacher && !names.includes(f.teacher) && <option value={f.teacher}>как на листе: {f.teacher}</option>}
                                            {names.map(t => <option key={t} value={t}>{t}</option>)}
                                        </select>
                                        <input className="field" placeholder="Кабинет" maxLength={50} value={f.room} onChange={e => set(n, 'room', e.target.value)} />
                                    </>}
                                    {verdict && <span className={`chip${verdict === 'Без изменений' ? ' chip--online' : ''}`}>{verdict}</span>}
                                </div></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="row ocr-actions">
                {Object.keys(edits).length > 0 && <button className="btn btn--tonal" disabled={busy} onClick={() => setEdits({})}>Сбросить правки</button>}
                <button className="btn btn--primary" disabled={busy} onClick={save}>Сохранить в замены</button>
            </div>
            {dialog}
        </>
    );
}

// Лист замен: модератор загружает фото листа, сервис kkmt-ocr распознаёт все группы,
// а строка своей группы сверяется с расписанием и после проверки сохраняется как замены на дату листа.
export default function SheetImport({ showMsg, onClose, onSaved }: { showMsg: (t: string) => void; onClose: () => void; onSaved: () => void }) {
    const [res, setRes] = useState<Result | null>(null);
    const [busy, setBusy] = useState(false);
    const [image, setImage] = useState('');
    const [query, setQuery] = useState('');
    const input = useRef<HTMLInputElement>(null);
    const own = (cached<{ groupName: string }>('/config')?.groupName ?? '').replace(/\s/g, '');
    const [sched, setSched] = useState<Sched | null>(() => cached<Sched>('/schedule') ?? null);
    const [aliases, setAliases] = useState<Alias[]>([]);
    const load = useCallback(() => {
        api<Sched>('GET', '/schedule').then(setSched).catch(e => showMsg(errText(e)));
        api<Alias[]>('GET', '/admin/ocr/aliases').then(setAliases).catch(e => showMsg(errText(e)));
    }, [showMsg]);
    useEffect(() => { load(); }, [load]);
    // строка своей группы; если название на листе прочиталось с ошибкой — её можно выбрать
    const [pick, setPick] = useState('');
    // дата листа — из заголовка; если не прочиталась, её можно выбрать
    const [date, setDate] = useState('');
    const [budget, setBudgetState] = useState(() => {
        try { const n = Number(localStorage.getItem(BUDGET_KEY)); return n >= 0 && n <= 3 && localStorage.getItem(BUDGET_KEY) !== null ? n : 2; } catch { return 2; }
    });
    const setBudget = (n: number) => {
        setBudgetState(n);
        try { localStorage.setItem(BUDGET_KEY, String(n)); } catch { /* не критично */ }
    };
    const ownRow = res?.groups.find(g => g.group === (pick || own));
    const sheet = res ? parseTitle(res.title, budget) : null;
    const dateDay = date ? (new Date(`${date}T00:00:00`).getDay() + 6) % 7 : -1;
    const week = date && sched ? weekNumber(new Date(`${date}T00:00:00`), sched.semesterStart) : 0;

    // Прогресс: загрузка фото — 0–40% (XHR), распознавание — 40–100% по ячейкам: сервер присылает строку
    // {"done","total"} после каждой распознанной ячейки, последней строкой — результат или {"error"}.
    const [progress, setProgress] = useState<{ stage: string; pct: number } | null>(null);
    const send = (f: File) => new Promise<Result>((resolve, reject) => {
        const x = new XMLHttpRequest();
        const lines = () => x.responseText.split('\n').filter(Boolean);
        x.open('POST', '/api/admin/ocr');
        x.upload.onprogress = e => { if (e.lengthComputable) setProgress({ stage: 'Загрузка фото', pct: Math.round((e.loaded / e.total) * 40) }); };
        x.upload.onload = () => setProgress({ stage: 'Распознаём', pct: 40 });
        x.onprogress = () => {
            const ls = lines();
            try {
                const d = JSON.parse(ls[ls.length - 1]); // последняя может быть недописана — тогда ждём следующую
                if (d.total) setProgress({ stage: `Распознаём: ${d.done} из ${d.total} ячеек`, pct: Math.round(40 + 60 * d.done / d.total) });
            } catch { /* строка пришла не целиком */ }
        };
        x.onerror = () => reject(new Error('Нет соединения'));
        x.onload = () => {
            let d: Result & { error?: string };
            try { d = JSON.parse(lines().pop() ?? ''); } catch { return reject(new Error(`Ошибка ${x.status}`)); }
            if (x.status >= 300 || d.error) return reject(new Error(d.error ?? `Ошибка ${x.status}`));
            resolve(d);
        };
        x.send(f);
    });

    const run = async (f?: File) => {
        if (!f) return;
        setBusy(true);
        setProgress({ stage: 'Загрузка фото', pct: 0 });
        setImage(old => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(f); });
        try {
            const d = await send(f);
            setProgress({ stage: 'Готово', pct: 100 });
            setRes(d);
            setPick('');
            setDate(parseTitle(d.title, budget).date);
        } catch (e) { showMsg(errText(e)); } finally {
            setBusy(false);
            window.setTimeout(() => setProgress(null), 400);
            if (input.current) input.current.value = '';
        }
    };

    const groups = (res?.groups ?? [])
        .filter(g => g.group.toLowerCase().includes(query.trim().toLowerCase().replace(/\s/g, '')))
        .sort((a, b) => Number(b.group === own) - Number(a.group === own));
    const cols = Math.max(5, ...(res?.groups ?? []).flatMap(g => g.pairs.map(p => p.pair)));

    return (
        <>
            <section className="card">
                <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span className="card-title">Скан</span>
                    <button className="btn btn--tonal btn--sm" onClick={onClose}>← К расписанию</button>
                </div>
                <p className="hint">Фото или скан листа «группы × пары» (JPG, PNG). Распознаются все группы; строку своей группы проверьте в сверке и сохраните в замены.</p>
                <input ref={input} type="file" hidden accept="image/jpeg,image/png" onChange={e => run(e.target.files?.[0])} />
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn btn--primary" disabled={busy} onClick={() => input.current?.click()}><IcoScan /> {busy ? 'Распознаём…' : 'Выбрать лист'}</button>
                    {res && <span className="hint">{res.title || 'Без заголовка'} · групп: {res.groups.length} · {(res.ms / 1000).toFixed(1)} с</span>}
                </div>
                {progress && (
                    <div className="hw-progress">
                        <span className="hw-progress-name"><span>{progress.stage}</span><b>{progress.pct}%</b></span>
                        <div className="hw-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.pct}><i style={{ width: `${progress.pct}%` }} /></div>
                    </div>
                )}
                {image && <details className="ocr-sheet"><summary>Показать лист</summary><img src={image} alt="Лист замен" /></details>}
            </section>

            {res && (
                <section className="card">
                    <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                        <span className="card-title">{own || 'Своя группа'} — сверка с расписанием</span>
                        <div className="row ocr-pick">
                            <select className="field ocr-search" aria-label="Строка группы на листе" value={pick || own} onChange={e => setPick(e.target.value)}>
                                {!res.groups.some(g => g.group === own) && <option value={own}>{own} — не найдена, выберите строку</option>}
                                {res.groups.map((g, i) => <option key={`${g.group}-${i}`} value={g.group}>{g.group}</option>)}
                            </select>
                            <input className="field ocr-search" type="date" value={date} onChange={e => setDate(e.target.value)} />
                        </div>
                    </div>
                    <div className="ocr-date">
                        <span className="hint">Бюджет на ошибки OCR (букв на слово):</span>
                        <div className="seg" role="tablist">
                            {[0, 1, 2, 3].map(n => <button key={n} role="tab" aria-selected={budget === n} onClick={() => setBudget(n)}>{n}</button>)}
                        </div>
                        <span className="hint">{['буквы не исправляются', 'строго', 'обычно', 'мягко — больше находит, но может ошибиться'][budget]} · не больше трети слова</span>
                    </div>
                    {sheet && (
                        <div className="ocr-date">
                            <span className="hint">На листе:</span>
                            <span>{[sheet.weekday >= 0 ? WEEKDAYS[sheet.weekday] : '', sheet.date ? sheet.date.split('-').reverse().join('.') : 'дата не прочиталась', sheet.parity].filter(Boolean).join(', ')}</span>
                            {date && <span className="hint">· у нас {WEEKDAYS[dateDay]}, {week}-я неделя ({week % 2 ? 'нечётная' : 'чётная'})</span>}
                            {sheet.weekday >= 0 && date && sheet.weekday !== dateDay && <span className="chip chip--error">День недели не совпадает с датой — проверьте дату</span>}
                            {date && date !== sheet.date && <span className="chip">Дата изменена вручную</span>}
                        </div>
                    )}
                    {!ownRow ? <p className="muted">Группа {own} на листе не найдена — выберите её строку в списке</p>
                        : !date ? <p className="muted">Дата в заголовке не прочиталась — выберите её</p>
                        : sched && <Compare key={`${res.title}|${ownRow.group}|${date}`} row={ownRow} sched={sched} date={date} budget={budget} aliases={aliases} showMsg={showMsg} onSaved={() => { load(); onSaved(); }} />}
                </section>
            )}

            {res && (
                <section className="card">
                    <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                        <span className="card-title">Группы</span>
                        <input className="field ocr-search" placeholder="Найти группу" value={query} onChange={e => setQuery(e.target.value)} />
                    </div>
                    <div className="ocr-legend hint">
                        <span><i className="ocr-sw ocr-sw--changed" /> выделено жёлтым на листе</span>
                        <span><i className="ocr-sw ocr-sw--moved" /> пара перенесена (зелёная метка «N ПАРА»)</span>
                        <span className="ocr-hover-hint">наведите на ячейку — исходный текст OCR</span>
                    </div>
                    <div className="ocr-scroll">
                        <table className="ocr-table ocr-groups">
                            <thead><tr><th>Группа</th>{Array.from({ length: cols }, (_, i) => <th key={i}>{i + 1} пара</th>)}</tr></thead>
                            <tbody>
                                {groups.map((g, gi) => (
                                    <tr key={`${g.group}-${gi}`} className={g.group === own ? 'ocr-own' : undefined}>
                                        <th>{g.group}</th>
                                        {Array.from({ length: cols }, (_, i) => {
                                            const p = g.pairs.find(x => x.pair === i + 1);
                                            if (!p) return <td key={i} />;
                                            return (
                                                <td key={i} data-label={`${i + 1} пара`} title={p.raw} className={`${p.changed ? 'ocr-changed' : ''}${p.moved ? ' ocr-moved' : ''}`}>
                                                    {p.room && <b>{p.room}</b>}
                                                    <span>{p.subject}</span>
                                                    {p.teacher && <span className="muted">{p.teacher}</span>}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
        </>
    );
}
