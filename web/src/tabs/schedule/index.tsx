import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, errText, isAdmin, type PageProps } from '../../lib/api';
import { IcoClip, IcoNote } from '../../components/icons';
import HomeworkBlock, { type HwItem } from './HomeworkBlock';
import './schedule.css';

export interface Lesson { id?: number; weekday: number; pair_no: number; parity: 'all' | 'odd' | 'even'; subject: string; teacher: string; room: string; kind: string }
export interface PairTime { pair_no: number; start_time: string; end_time: string }
interface Data { lessons: Lesson[]; times: PairTime[]; satTimes?: PairTime[]; semesterStart: string | null }

const DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DAY_MS = 86400_000;
const VIEW_KEY = 'kkmt.scheduleView';

// Номер учебной недели (1 — неделя начала семестра); нечётная = odd.
function weekNumber(date: Date, semesterStart: string | null): number {
    if (!semesterStart) return 1;
    const start = new Date(`${semesterStart}T00:00:00`);
    const startMonday = new Date(start); startMonday.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const monday = new Date(date); monday.setDate(date.getDate() - ((date.getDay() + 6) % 7)); monday.setHours(0, 0, 0, 0);
    return Math.round((monday.getTime() - startMonday.getTime()) / (7 * DAY_MS)) + 1;
}
// «Иванова Елена Петровна» → «Иванова Е. П.» (в ячейках); полностью — в попапе
const shortName = (full: string) => {
    const [surname, ...rest] = full.trim().split(/\s+/);
    return rest.length ? `${surname} ${rest.map(p => `${p[0].toUpperCase()}.`).join(' ')}` : surname ?? '';
};
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

export default function Schedule({ me, showMsg }: PageProps) {
    const [data, setData] = useState<Data | null>(null);
    const [view, setViewState] = useState<'grid' | 'cards'>(() => {
        try {
            const v = localStorage.getItem(VIEW_KEY);
            if (v === 'grid' || v === 'cards') return v;
        } catch { /* не критично */ }
        return window.matchMedia('(max-width: 640px)').matches ? 'cards' : 'grid';
    });
    const [sel, setSel] = useState<{ lesson: Lesson; day: string; date: string; anchor: HTMLElement; pop: boolean } | null>(null);
    const [hw, setHw] = useState<Record<string, HwItem>>({});
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    const popRef = useRef<HTMLDivElement>(null);
    // Десктоп — попап рядом с нажатой парой, телефон — окно по центру
    const openLesson = (lesson: Lesson, day: string, date: string, anchor: HTMLElement) =>
        setSel({ lesson, day, date, anchor, pop: window.matchMedia('(min-width: 641px)').matches });
    const setView = (v: 'grid' | 'cards') => {
        setViewState(v);
        try { localStorage.setItem(VIEW_KEY, v); } catch { /* не критично */ }
    };
    const now = new Date();
    const todayIdx = (now.getDay() + 6) % 7; // 0 = Пн
    const [day, setDay] = useState(Math.min(todayIdx, 5));

    useEffect(() => {
        if (!sel) return;
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setSel(null); };
        const down = (e: MouseEvent) => {
            if (sel.pop && !popRef.current?.contains(e.target as Node)) setSel(null);
        };
        const close = () => setSel(null);
        const scroll = (e: Event) => { if (!popRef.current?.contains(e.target as Node)) setSel(null); };
        document.addEventListener('keydown', key);
        document.addEventListener('mousedown', down);
        window.addEventListener('resize', close);
        window.addEventListener('scroll', scroll, true);
        sel.anchor.classList.add('is-sel');
        return () => {
            document.removeEventListener('keydown', key);
            document.removeEventListener('mousedown', down);
            window.removeEventListener('resize', close);
            window.removeEventListener('scroll', scroll, true);
            sel.anchor.classList.remove('is-sel');
        };
    }, [sel]);

    // Позиция попапа: справа от пары, если не хватает места — слева; по вертикали по центру пары, в пределах окна.
    // Пересчитывается и при смене высоты (редактирование дз, список файлов).
    useLayoutEffect(() => {
        const el = popRef.current;
        if (!sel?.pop || !el) { setPos(null); return; }
        const place = () => {
            const r = sel.anchor.getBoundingClientRect();
            const { width: w, height: h } = el.getBoundingClientRect();
            const gap = 10;
            let left = r.right + gap;
            if (left + w > window.innerWidth - 8) left = r.left - gap - w;
            left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
            const top = Math.max(8, Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 8));
            setPos(p => (p && p.left === left && p.top === top ? p : { left, top }));
        };
        place();
        const ro = new ResizeObserver(place);
        ro.observe(el);
        return () => ro.disconnect();
    }, [sel]);

    useEffect(() => { api<Data>('GET', '/schedule').then(setData).catch(e => showMsg(errText(e))); }, [showMsg]);

    const target = useMemo(() => new Date(), []);
    const weekDates = useMemo(() => {
        const mon = new Date(target); mon.setDate(target.getDate() - ((target.getDay() + 6) % 7));
        return Array.from({ length: 6 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return iso(d); });
    }, [target]);
    const loadHw = useCallback(() => {
        api<{ items: HwItem[] }>('GET', `/homework?from=${weekDates[0]}&to=${weekDates[5]}`)
            .then(d => setHw(Object.fromEntries(d.items.map(i => [`${i.date}|${i.pair_no}`, i]))))
            .catch(() => { /* значки не критичны */ });
    }, [weekDates]);
    useEffect(() => { loadHw(); }, [loadHw]);
    // Метки в ячейке: «добавлено дз» и «добавлено файлов: N»
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
    const maxPair = Math.max(data.times.length, satTimes.size, ...data.lessons.map(l => l.pair_no), 0);
    const rows = Array.from({ length: maxPair }, (_, i) => i + 1);

    return (
        <div className={`sched sched--${view}`}>
            <div className="week-bar">
                <span className="date-pill">{target.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                <div className="seg sched-view" role="tablist" aria-label="Вид расписания">
                    <button role="tab" aria-selected={view === 'grid'} onClick={() => setView('grid')}>Сетка</button>
                    <button role="tab" aria-selected={view === 'cards'} onClick={() => setView('cards')}>Карточки</button>
                </div>
            </div>

            <div className="seg seg--full day-pills" role="tablist" aria-label="День недели">
                {SHORT.map((s, i) => (
                    <button key={s} role="tab" aria-selected={day === i} className={i === todayIdx ? 'seg--today' : ''} onClick={() => setDay(i)}>{s}</button>
                ))}
            </div>

            <div className="sched-grid" role="table" aria-label="Расписание на неделю" style={{ '--rows': rows.length } as React.CSSProperties}>
                <div className="sg-corner" role="columnheader" />
                {DAYS.map((name, i) => (
                    <div key={name} role="columnheader" className={`sg-head${i === todayIdx ? ' sg-head--today' : ''}`}>{name}</div>
                ))}
                {rows.map(n => {
                    const t = times.get(n);
                    return (
                        <div key={n} style={{ display: 'contents' }} role="row">
                            <div className="sg-time" role="rowheader"><b>{n}</b>{t && <span>{t.start_time}<br />{t.end_time}</span>}</div>
                            {DAYS.map((name, i) => {
                                const cell = data.lessons.filter(l => l.weekday === i + 1 && l.pair_no === n && (l.parity === 'all' || l.parity === parity));
                                const ct = timeOf(i, n);
                                const going = i === todayIdx && !!ct && nowMin >= toMin(ct.start_time) && nowMin < toMin(ct.end_time);
                                return (
                                    <div key={name} role="cell" className={`sg-cell${cell.length ? ' sg-cell--full' : ''}${going ? ' sg-cell--now' : ''}`}>
                                        {i === 5 && satTimes.size > 0 && ct && <span className="sg-sat-time">{ct.start_time}–{ct.end_time}</span>}
                                        {cell.map(l => (
                                            <button key={`${l.subject}-${l.parity}`} type="button" className="sg-lesson lesson-hit" onClick={e => openLesson(l, name, weekDates[i], e.currentTarget)}>
                                                <div className="lesson-subj">{l.subject}</div>
                                                <div className="sg-meta">{[l.teacher && shortName(l.teacher), l.room && `ауд. ${l.room}`].filter(Boolean).join(' · ')}</div>
                                                {l.parity !== 'all' && <span className="chip">{l.parity === 'odd' ? 'нечёт.' : 'чёт.'}</span>}
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

            <div className="sched-cards">
            {DAYS.map((name, i) => {
                const lessons = data.lessons.filter(l => l.weekday === i + 1 && (l.parity === 'all' || l.parity === parity));
                if (i === 5 && lessons.length === 0) return null;
                const isToday = i === todayIdx;
                return (
                    <section key={name} className={`card${isToday ? ' day-card--today' : ''}${day === i ? '' : ' day-card--hidden'}`}>
                        <div className="day-head">
                            <span className="card-title grow">{name}</span>
                            {isToday && <span className="chip chip--primary">Сегодня</span>}
                        </div>
                        <div className="day-rows" style={{ '--rows': rows.length } as React.CSSProperties}>
                            {rows.map(n => {
                                const t = timeOf(i, n);
                                const cell = lessons.filter(l => l.pair_no === n);
                                const going = isToday && !!t && nowMin >= toMin(t.start_time) && nowMin < toMin(t.end_time);
                                return (
                                    <div key={n} className={`lesson${cell.length ? ' lesson--hit' : ' lesson--empty'}${going ? ' lesson--now' : ''}`}
                                         role={cell.length ? 'button' : undefined} tabIndex={cell.length ? 0 : undefined}
                                         onClick={e => cell[0] && openLesson(cell[0], name, weekDates[i], e.currentTarget)}
                                         onKeyDown={e => { if (e.key === 'Enter' && cell[0]) openLesson(cell[0], name, weekDates[i], e.currentTarget); }}>
                                        <div className="lesson-time"><b>{t?.start_time ?? `${n} п.`}</b>{t?.end_time}</div>
                                        <div className="grow">
                                            {cell.map(l => (
                                                <div key={`${l.subject}-${l.parity}`}>
                                                    <div className="lesson-subj">{l.subject}</div>
                                                    <div className="lesson-meta">{[l.teacher && shortName(l.teacher), l.room && `ауд. ${l.room}`].filter(Boolean).join(' · ')}</div>
                                                </div>
                                            ))}
                                        </div>
                                        {cell.length === 1 && cell[0].parity !== 'all' && <span className="chip">{cell[0].parity === 'odd' ? 'нечёт.' : 'чёт.'}</span>}
                                        {cell.length > 0 && hwBadge(weekDates[i], n)}
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                );
            })}
            </div>

            {sel && (() => {
                const l = sel.lesson, t = timeOf(l.weekday - 1, l.pair_no);
                const rowsInfo: [string, string][] = [
                    ['День', `${sel.day}, ${sel.date.slice(8)}.${sel.date.slice(5, 7)}`],
                    ['Пара', `${l.pair_no}${t ? ` · ${t.start_time}–${t.end_time}` : ''}`],
                    ['Тип', l.kind || '—'],
                    ['Преподаватель', l.teacher || '—'],
                    ['Аудитория', l.room || '—'],
                    ['Неделя', l.parity === 'all' ? 'Каждая' : l.parity === 'odd' ? 'Нечётная' : 'Чётная'],
                ];
                const info = (
                    <>
                        <dl className="lesson-info">
                            {rowsInfo.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
                        </dl>
                        <HomeworkBlock date={sel.date} pair={l.pair_no} item={hw[`${sel.date}|${l.pair_no}`]} canEdit={isAdmin(me)} onChanged={loadHw} showMsg={showMsg} />
                    </>
                );
                if (sel.pop) {
                    return (
                        <div ref={popRef} className="lesson-pop" role="dialog" aria-labelledby="lesson-title"
                             style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
                            <div className="lesson-pop-head">
                                <h2 className="lesson-pop-title" id="lesson-title">{l.subject}</h2>
                                <button className="btn-icon btn-icon--neutral" aria-label="Закрыть" onClick={() => setSel(null)}>✕</button>
                            </div>
                            {info}
                        </div>
                    );
                }
                return (
                    <div className="scrim-dialog" onMouseDown={e => { if (e.target === e.currentTarget) setSel(null); }}>
                        <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="lesson-title">
                            <h2 className="dialog-title" id="lesson-title">{l.subject}</h2>
                            {info}
                            <div className="dialog-actions"><button className="btn btn--tonal" autoFocus onClick={() => setSel(null)}>Закрыть</button></div>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}
