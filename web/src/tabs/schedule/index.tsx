import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, cached, errText, isModerator, type PageProps } from '../../lib/api';
import { IcoCalendar, IcoClip, IcoEdit, IcoNote, IcoScan } from '../../components/icons';
import type { HwItem } from './HomeworkBlock';
import ScheduleEditor from './ScheduleEditor';
import SheetImport from './SheetImport';
import DatePicker from './DatePicker';
import './schedule.css';

export interface Lesson { id?: number; weekday: number; pair_no: number; parity: 'all' | 'odd' | 'even'; subject: string; teacher: string; room: string; kind: string; remote: boolean; changed?: boolean }
// Замена пары на дату (правка «только этой недели»); пустой subject — пары нет
export interface LessonChange { date: string; pair_no: number; subject: string; teacher: string; room: string; kind: string; remote: boolean }
export interface PairTime { pair_no: number; start_time: string; end_time: string }
export interface Teacher { name: string; phone: string; email: string; vk: string; tg: string }
interface Data { lessons: Lesson[]; changes?: LessonChange[]; teachers?: Teacher[]; times: PairTime[]; satTimes?: PairTime[]; semesterStart: string | null }

const DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DAY_MS = 86400_000;
const VIEW_KEY = 'kkmt.scheduleView';

// Номер учебной недели (1 — неделя начала семестра); нечётная = odd.
export function weekNumber(date: Date, semesterStart: string | null): number {
    if (!semesterStart) return 1;
    const start = new Date(`${semesterStart}T00:00:00`);
    const startMonday = new Date(start); startMonday.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const monday = new Date(date); monday.setDate(date.getDate() - ((date.getDay() + 6) % 7)); monday.setHours(0, 0, 0, 0);
    return Math.round((monday.getTime() - startMonday.getTime()) / (7 * DAY_MS)) + 1;
}
// Предмет пары в дату по постоянному расписанию (день недели + чётность недели)
export function subjectAt(lessons: Lesson[], semesterStart: string | null, date: string, pair: number) {
    const d = new Date(`${date}T00:00:00`);
    const parity = weekNumber(d, semesterStart) % 2 === 1 ? 'odd' : 'even';
    return lessons.find(l => l.weekday === (d.getDay() + 6) % 7 + 1 && l.pair_no === pair && (l.parity === 'all' || l.parity === parity))?.subject;
}
// «Иванова Елена Петровна» → «Иванова Е. П.» (в ячейках); полностью — в попапе
const shortName = (full: string) => {
    const [surname, ...rest] = full.trim().split(/\s+/);
    return rest.length ? `${surname} ${rest.map(p => `${p[0].toUpperCase()}.`).join(' ')}` : surname ?? '';
};
// «20 сентября» по дате ГГГГ-ММ-ДД
const dayMonth = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

export default function Schedule({ me, showMsg, focus, goTo, openLesson: open, closeLesson, lessonOpen, lessonRev }: PageProps) {
    const [data, setData] = useState<Data | null>(() => cached<Data>('/schedule') ?? null);
    const [view, setViewState] = useState<'grid' | 'cards'>(() => {
        try {
            const v = localStorage.getItem(VIEW_KEY);
            if (v === 'grid' || v === 'cards') return v;
        } catch { /* не критично */ }
        return window.matchMedia('(max-width: 640px)').matches ? 'cards' : 'grid';
    });
    // значки «есть ДЗ / файлы» в ячейках недели
    const [hw, setHw] = useState<Record<string, HwItem>>({});
    // Подробности пары открывает App: ПК — панель справа (расписание сдвигается влево), телефон — шторка снизу
    // повторное нажатие на уже открытую пару закрывает подробности
    const openLesson = (l: Lesson, day: string, date: string) =>
        lessonOpen?.date === date && lessonOpen.pair_no === l.pair_no ? closeLesson() : open({ subject: l.subject, teacher: l.teacher, room: l.room, pair_no: l.pair_no, weekday: l.weekday, day, date, pop: window.matchMedia('(min-width: 641px)').matches });
    const isOpen = (i: number, n: number) => lessonOpen?.date === weekDates[i] && lessonOpen.pair_no === n;
    const setView = (v: 'grid' | 'cards') => {
        setViewState(v);
        try { localStorage.setItem(VIEW_KEY, v); } catch { /* не критично */ }
    };
    const now = new Date();
    // Неделя показа: текущая или неделя даты, на которую перешли (например, из «Материалов»)
    const target = useMemo(() => (focus ? new Date(`${focus.date}T00:00:00`) : new Date()), [focus]);
    const todayIdx = (now.getDay() + 6) % 7; // 0 = Пн
    const [day, setDay] = useState(Math.min((target.getDay() + 6) % 7, 5));
    useEffect(() => { setDay(Math.min((target.getDay() + 6) % 7, 5)); }, [target]);
    // Правка расписания прямо в карточке дня: замены на эту неделю или постоянное расписание
    const [editing, setEditing] = useState<'week' | 'all' | null>(null);
    // «Скан» — распознавание фото листа замен (вместо сетки)
    const [importing, setImporting] = useState(false);
    const [dial, setDial] = useState(false);
    // календарь по нажатию на дату: переход на любую неделю, в том числе прошлую (чтобы добавить дз и файлы задним числом)
    const [picking, setPicking] = useState(false);
    const [dir, setDir] = useState<'next' | 'prev'>('next');
    const touch = useRef<{ x: number; y: number } | null>(null);

    // режим правки расписания — открытая пара не нужна
    useEffect(() => { if (editing) closeLesson(); }, [editing, closeLesson]);

    const load = useCallback(() => { api<Data>('GET', '/schedule').then(setData).catch(e => showMsg(errText(e))); }, [showMsg]);
    useEffect(() => { load(); }, [load]);

    const weekDates = useMemo(() => {
        const mon = new Date(target); mon.setDate(target.getDate() - ((target.getDay() + 6) % 7));
        return Array.from({ length: 6 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return iso(d); });
    }, [target]);
    const loadHw = useCallback(() => {
        const url = `/homework?from=${weekDates[0]}&to=${weekDates[5]}`;
        const show = (d: { items: HwItem[] }) => setHw(Object.fromEntries(d.items.map(i => [`${i.date}|${i.pair_no}`, i])));
        const c = cached<{ items: HwItem[] }>(url);
        if (c) show(c);
        api<{ items: HwItem[] }>('GET', url).then(show).catch(() => { /* значки не критичны */ });
    }, [weekDates]);
    // lessonRev: в подробностях что-то поменяли — обновить значки
    useEffect(() => { loadHw(); }, [loadHw, lessonRev]);
    // Метки в ячейке: «добавлено дз», «добавлено файлов: N» и «добавлено ссылок: N»
    const hwBadge = (date: string, pair: number) => {
        const h = hw[`${date}|${pair}`];
        const n = h?.files.length ?? 0;
        if (!h || (!h.body && n === 0)) return null;
        return (
            <span className="hw-badges">
                {h.body && <span className="hw-badge" title="Добавлено домашнее задание"><IcoNote /></span>}
                {n > 0 && <span className="hw-badge" title={`Добавлено файлов: ${n}`}><IcoClip />{n}</span>}
            </span>
        );
    };
    if (!data) return null;

    const wn = weekNumber(target, data.semesterStart);
    const parity: 'odd' | 'even' = wn % 2 === 1 ? 'odd' : 'even';
    const times = new Map(data.times.map(t => [t.pair_no, t]));
    const satTimes = new Map((data.satTimes ?? []).map(t => [t.pair_no, t]));
    // Время пары зависит от дня: у субботы свои звонки (если заданы)
    const timeOf = (dayIdx: number, pair: number) => (dayIdx === 5 && satTimes.size ? satTimes : times).get(pair);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const changes = data.changes ?? [];
    // Пары каждого дня этой недели с учётом замен
    // столбец сегодняшнего дня; -1 — показана другая неделя
    const cur = weekDates.indexOf(iso(now));
    const isFocus = (i: number, n: number) => !!focus && focus.date === weekDates[i] && focus.pair === n;
    const days = DAYS.map((_, i) => {
        const ch = changes.filter(c => c.date === weekDates[i]);
        const base = data.lessons.filter(l => l.weekday === i + 1 && (l.parity === 'all' || l.parity === parity) && !ch.some(c => c.pair_no === l.pair_no));
        return [...base, ...ch.filter(c => c.subject).map(c => ({ ...c, weekday: i + 1, parity: 'all' as const, changed: true }))];
    });
    const maxPair = Math.max(data.times.length, satTimes.size, ...data.lessons.map(l => l.pair_no), ...changes.map(c => c.pair_no), 0);
    const rows = Array.from({ length: maxPair }, (_, i) => i + 1);

    if (importing) return <SheetImport showMsg={showMsg} onClose={() => setImporting(false)} onSaved={load} />;

    return (
        <div className={`sched sched--${view}${editing ? ' sched--editing' : ''}`}>
            <div className="week-bar">
                <button className="date-pill date-pill--btn" title="Выбрать дату" onClick={() => setPicking(true)}>
                    <IcoCalendar />{target.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                </button>
                {picking && <DatePicker value={target} onClose={() => setPicking(false)} onPick={d => { setPicking(false); goTo('schedule', { date: d, pair: 0 }); }} />}
                {cur < 0 && <button className="btn btn--tonal btn--sm" onClick={() => goTo('schedule')}>К сегодня</button>}
                <span className="chip chip--primary">{parity === 'odd' ? 'Нечётная' : 'Чётная'} неделя</span>
                <div className="seg sched-view" role="tablist" aria-label="Вид расписания">
                    <button role="tab" aria-selected={view === 'grid'} onClick={() => setView('grid')}>Сетка</button>
                    <button role="tab" aria-selected={view === 'cards'} onClick={() => setView('cards')}>Карточки</button>
                </div>
                {/* десктоп — кнопка с меню, телефон — FAB с двумя кнопками над ним */}
                {isModerator(me) && !editing && (
                    <button className="theme-toggle theme-toggle--inline" title="Скан" aria-label="Скан — распознать фото листа замен" onClick={() => setImporting(true)}><IcoScan /></button>
                )}
                {isModerator(me) && !editing && (
                    <div className="edit-dial">
                        {dial && (
                            <div className="edit-dial-menu">
                                <button className="btn btn--tonal" onClick={() => { setEditing('week'); setDial(false); }}>Эта неделя</button>
                                <button className="btn btn--tonal" onClick={() => { setEditing('all'); setDial(false); }}>Всё расписание</button>
                            </div>
                        )}
                        <button className="edit-dial-btn" aria-expanded={dial} aria-label="Редактировать расписание" onClick={() => setDial(o => !o)}>
                            {dial ? '✕' : <IcoEdit />}<span>Редактировать</span>
                        </button>
                    </div>
                )}
            </div>

            <div className="seg seg--full day-pills" role="tablist" aria-label="День недели">
                {SHORT.map((s, i) => (
                    <button key={s} role="tab" aria-selected={day === i} className={i === cur ? 'seg--today' : ''} onClick={() => { setDir(i < day ? 'prev' : 'next'); setDay(i); }}>{s}</button>
                ))}
            </div>

            {editing && (
                <ScheduleEditor mode={editing} day={day} dayName={editing === 'week' ? `${DAYS[day]} (${dayMonth(weekDates[day])})` : DAYS[day]} timeOf={n => timeOf(day, n)} lessons={data.lessons} changes={changes} weekDates={weekDates} parity={parity} pairs={maxPair}
                                onClose={() => setEditing(null)} onSaved={load} showMsg={showMsg} />
            )}

            <div className="sched-grid" role="table" aria-label="Расписание на неделю" style={{ '--rows': rows.length } as React.CSSProperties}>
                <div className="sg-corner" role="columnheader" />
                {DAYS.map((name, i) => (
                    <div key={name} role="columnheader" className={`sg-head${i === cur ? ' sg-head--today' : ''}`}>
                        <span className="sg-day-full">{name}<small className="sg-date">({dayMonth(weekDates[i])})</small></span><span className="sg-day-short">{SHORT[i]}</span>
                    </div>
                ))}
                {rows.map(n => {
                    const t = times.get(n);
                    return (
                        <div key={n} style={{ display: 'contents' }} role="row">
                            <div className="sg-time" role="rowheader"><b>{n}</b>{t && <span>{t.start_time}<br />{t.end_time}</span>}</div>
                            {DAYS.map((name, i) => {
                                const cell = days[i].filter(l => l.pair_no === n);
                                const ct = timeOf(i, n);
                                const going = i === cur && !!ct && nowMin >= toMin(ct.start_time) && nowMin < toMin(ct.end_time);
                                return (
                                    <div key={name} role="cell" className={`sg-cell${cell.length ? ' sg-cell--full' : ''}${cell.some(l => l.remote) ? ' sg-cell--remote' : ''}${going ? ' sg-cell--now' : ''}${isFocus(i, n) ? ' is-focus' : ''}`}>
                                        {i === 5 && satTimes.size > 0 && ct && <span className="sg-sat-time">{ct.start_time}–{ct.end_time}</span>}
                                        {cell.map(l => (
                                            <button key={`${l.subject}-${l.parity}`} type="button" className={`sg-lesson lesson-hit${isOpen(i, n) ? ' is-sel' : ''}`} onClick={() => openLesson(l, name, weekDates[i])}>
                                                <div className="lesson-subj">{l.subject}</div>
                                                <div className="sg-meta">{[l.teacher && shortName(l.teacher), l.room && `ауд. ${l.room}`].filter(Boolean).join(' · ')}</div>
                                                {l.parity !== 'all' && <span className="chip">{l.parity === 'odd' ? 'нечёт.' : 'чёт.'}</span>}
                                                {l.changed && <span className="chip chip--tertiary">замена</span>}
                                                {l.remote && <span className="chip chip--remote">дистант</span>}
                                                {hwBadge(weekDates[i], n)}
                                            </button>
                                        ))}
                                    </div>
                                );
                            })}
                        </div>
                    );
                })}
            </div>

            <div className="sched-cards" data-dir={dir}
                 onTouchStart={e => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
                 onTouchEnd={e => {
                     if (!touch.current) return;
                     const dx = e.changedTouches[0].clientX - touch.current.x, dy = e.changedTouches[0].clientY - touch.current.y;
                     touch.current = null;
                     // горизонтальный свайп — соседний день; суббота только если в ней есть пары
                     if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
                     const last = days[5].length ? 5 : 4;
                     const next = Math.max(0, Math.min(last, day + (dx < 0 ? 1 : -1)));
                     if (next !== day) { setDir(dx < 0 ? 'next' : 'prev'); setDay(next); }
                 }}>
            {DAYS.map((name, i) => {
                const lessons = days[i];
                if (i === 5 && lessons.length === 0) return null;
                const isToday = i === cur;
                return (
                    <section key={name} className={`card${isToday ? ' day-card--today' : ''}${day === i ? '' : ' day-card--hidden'}`}>
                        <div className="day-head">
                            <span className="card-title grow">{name} ({dayMonth(weekDates[i])})</span>
                            {isToday && <span className="chip chip--primary">Сегодня</span>}
                        </div>
                        <div className="day-rows" style={{ '--rows': rows.length } as React.CSSProperties}>
                            {rows.map(n => {
                                const t = timeOf(i, n);
                                const cell = lessons.filter(l => l.pair_no === n);
                                const going = isToday && !!t && nowMin >= toMin(t.start_time) && nowMin < toMin(t.end_time);
                                return (
                                    <div key={n} className={`lesson${cell.length ? ' lesson--hit' : ' lesson--empty'}${cell.some(l => l.remote) ? ' lesson--remote' : ''}${going ? ' lesson--now' : ''}${isFocus(i, n) ? ' is-focus' : ''}${isOpen(i, n) ? ' is-sel' : ''}`}
                                         role={cell.length ? 'button' : undefined} tabIndex={cell.length ? 0 : undefined}
                                         onClick={() => cell[0] && openLesson(cell[0], name, weekDates[i])}
                                         onKeyDown={e => { if (e.key === 'Enter' && cell[0]) openLesson(cell[0], name, weekDates[i]); }}>
                                        <div className="lesson-time"><b>{t?.start_time ?? `${n} п.`}</b>{t?.end_time}</div>
                                        <div className="grow">
                                            {cell.map(l => (
                                                <div key={`${l.subject}-${l.parity}`}>
                                                    <div className="lesson-subj" title={l.subject}>{l.subject}</div>
                                                    <div className="lesson-meta">{[l.teacher && shortName(l.teacher), l.room && `ауд. ${l.room}`].filter(Boolean).join(' · ')}</div>
                                                </div>
                                            ))}
                                        </div>
                                        {cell.length === 1 && (cell[0].parity !== 'all' || cell[0].changed || cell[0].remote) && (
                                            <span className="lesson-chips">
                                                {cell[0].parity !== 'all' && <span className="chip">{cell[0].parity === 'odd' ? 'нечёт.' : 'чёт.'}</span>}
                                                {cell[0].changed && <span className="chip chip--tertiary">замена</span>}
                                                {cell[0].remote && <span className="chip chip--remote">дистант</span>}
                                            </span>
                                        )}
                                        {cell.length > 0 && hwBadge(weekDates[i], n)}
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                );
            })}
            </div>
        </div>
    );
}
