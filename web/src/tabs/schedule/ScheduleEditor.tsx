import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, errText } from '../../lib/api';
import { IcoCheck, IcoPlus, IcoUndo } from '../../components/icons';
import type { Lesson, LessonChange, PairTime } from '.';

type Fields = Pick<Lesson, 'subject' | 'teacher' | 'room' | 'kind' | 'remote'>;
const EMPTY: Fields = { subject: '', teacher: '', room: '', kind: '', remote: false };
const KEYS = ['subject', 'teacher', 'room', 'kind'] as const;
const pick = (l?: Fields): Fields => (l ? { subject: l.subject, teacher: l.teacher, room: l.room, kind: l.kind, remote: !!l.remote } : EMPTY);
const same = (a: Fields, b: Fields) => KEYS.every(k => a[k].trim() === b[k].trim()) && !!a.remote === !!b.remote;
const ddmm = (d: string) => `${d.slice(8)}.${d.slice(5, 7)}`;
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const uniq = (list: string[]) => [...new Set(list.map(s => s.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));

// Редактор расписания в виде карточки дня (модераторы и выше): те же строки пар, но текст редактируется прямо в них.
// Режимы: замены на эту неделю или постоянное расписание. Черновик хранится для всех дней, сохраняется одной кнопкой.
export default function ScheduleEditor({ mode, day, dayName, timeOf, lessons, changes, weekDates, parity, pairs, onClose, onSaved, showMsg }: {
    mode: 'week' | 'all'; day: number; dayName: string; timeOf: (pair: number) => PairTime | undefined;
    lessons: Lesson[]; changes: LessonChange[]; weekDates: string[]; parity: 'odd' | 'even'; pairs: number;
    onClose: () => void; onSaved: () => void; showMsg: (t: string) => void;
}) {
    const [busy, setBusy] = useState(false);
    // Пара из постоянного расписания для слота этой недели
    const base = (i: number, n: number) => pick(lessons.find(l => l.weekday === i + 1 && l.pair_no === n && (l.parity === 'all' || l.parity === parity)));
    const [week, setWeek] = useState(() => weekDates.map((date, i) => Array.from({ length: pairs }, (_, k) => {
        const c = changes.find(c => c.date === date && c.pair_no === k + 1);
        return c ? pick(c) : base(i, k + 1);
    })));
    const [all, setAll] = useState(() => lessons.map(l => ({ ...l })));
    // Варианты для выбора — из расписания, замен и черновика (новый предмет сразу появляется в списке)
    const known: Fields[] = [...lessons, ...changes, ...all, ...week.flat()];
    const teacherOf = (subject: string) => known.find(l => l.subject === subject && l.teacher)?.teacher ?? '';
    const subjectItems = uniq(known.map(l => l.subject)).map(s => ({ title: s, sub: uniq(known.filter(l => l.subject === s).map(l => l.teacher)).join(', ') }));
    const teacherItems = uniq(known.map(l => l.teacher)).map(t => ({ title: t, sub: uniq(known.filter(l => l.teacher === t).map(l => l.subject)).join(' · ') }));
    const [sheet, setSheet] = useState<{ title: string; hint: string; empty: string; value: string; items: Item[]; set: (v: string) => void } | null>(null);

    // Прошедшие дни недели только для просмотра (сервер их тоже не меняет)
    const locked = mode === 'week' && weekDates[day] < iso(new Date());
    // Постоянное расписание правится по неделям: видны пары выбранной чётности и «каждую неделю»
    const [wp, setWp] = useState<'odd' | 'even'>(parity);
    const otherP = wp === 'odd' ? 'even' : 'odd';
    const visible = (l: Lesson) => l.weekday === day + 1 && (l.parity === 'all' || l.parity === wp);

    const setSlot = (j: number, f: Fields) => setWeek(w => w.map((d, i) => (i === day ? d.map((x, k) => (k === j ? f : x)) : d)));
    const setLesson = (idx: number, l: Lesson) => setAll(a => a.map((x, k) => (k === idx ? l : x)));

    const save = async () => {
        setBusy(true);
        try {
            if (mode === 'all') await api('PUT', '/admin/schedule', { lessons: all.filter(l => l.subject.trim()) });
            else await api('PUT', '/admin/schedule/week', {
                from: weekDates[0], to: weekDates[5],
                changes: week.flatMap((d, i) => d.map((f, j) => ({ date: weekDates[i], pair_no: j + 1, ...f })).filter((c, j) => !same(c, base(i, j + 1)))),
            });
            showMsg('Расписание сохранено');
            onSaved();
            onClose();
        } catch (e) { showMsg(errText(e)); } finally { setBusy(false); }
    };

    // MD3 outlined text field: подпись внутри поля, при фокусе или с текстом всплывает на рамку
    const field = (label: string, value: string, max: number, set: (v: string) => void, cls = '') => (
        <label className={`tf ${cls}`}>
            <input className="tf-in" placeholder=" " maxLength={max} value={value} onChange={e => set(e.target.value)} />
            <span className="tf-label">{label}</span>
        </label>
    );

    // Поле-кнопка в стиле MD3 outlined field: открывает шторку выбора
    const choose = (label: string, empty: string, value: string, items: Item[], set: (v: string) => void, cls: string) => (
        <div className={`tf ${cls}`}>
            <button type="button" className="tf-in tf-btn" onClick={() => setSheet({ title: label, hint: `Выберите из списка или добавьте через «+».`, empty, value, items, set })}>
                {value || <span className="tf-empty">{empty}</span>}
            </button>
            <span className="tf-label">{label}</span>
        </div>
    );

    // MD3 filter chip: выбранный — жёлтый с галочкой
    const remoteChip = (label: string, on: boolean, toggle: () => void) => (
        <button type="button" className="fchip" aria-pressed={on} onClick={toggle}>{on && <IcoCheck />}{label}</button>
    );
    // «Весь день дистант»: включает у всех пар дня (или выключает, если уже у всех)
    const dayFilled = mode === 'week' ? week[day].filter(f => f.subject.trim()) : all.filter(l => visible(l) && l.subject.trim());
    const dayRemote = dayFilled.length > 0 && dayFilled.every(f => f.remote);
    const toggleDay = () => mode === 'week'
        ? setWeek(w => w.map((d, i) => (i === day ? d.map(f => (f.subject.trim() ? { ...f, remote: !dayRemote } : f)) : d)))
        : setAll(a => a.map(l => (visible(l) && l.subject.trim() ? { ...l, remote: !dayRemote } : l)));

    // Строка пары как в карточке дня: время слева, справа поля, ниже — чипы
    const row = (key: string, n: number, f: Fields, set: (f: Fields) => void, changed: boolean, extra?: ReactNode, action?: ReactNode) => {
        const t = timeOf(n);
        return (
            <div key={key} className={`lesson se-lesson${changed ? ' se-lesson--changed' : ''}${f.remote ? ' lesson--remote' : ''}`}>
                <div className="lesson-time"><b>{t?.start_time ?? `${n} п.`}</b>{t?.end_time}</div>
                <div className="grow se-grid">
                    {choose('Предмет', 'Нет пары', f.subject, subjectItems, v => set({ ...f, subject: v, teacher: !f.teacher || f.teacher === teacherOf(f.subject) ? teacherOf(v) : f.teacher }), 'se-subj')}
                    {choose('Преподаватель', 'Не указан', f.teacher, teacherItems, v => set({ ...f, teacher: v }), 'se-teacher')}
                    {field('Аудитория', f.room, 50, v => set({ ...f, room: v }), 'se-wide')}
                    <div className="se-chips">
                        {f.subject.trim() && remoteChip('Дистант', !!f.remote, () => set({ ...f, remote: !f.remote }))}
                        {extra}
                    </div>
                </div>
                {action}
            </div>
        );
    };

    const slots = Array.from({ length: pairs }, (_, k) => k + 1);

    return (
        <section className="card se">
            <div className="day-head">
                <span className="card-title grow">{dayName}</span>
                <span className="chip chip--primary">{mode === 'week' ? `Замены · ${ddmm(weekDates[day])}` : 'Постоянное'}</span>
            </div>
            {mode === 'all' && (
                <div className="seg seg--full" role="tablist" aria-label="Неделя">
                    {(['odd', 'even'] as const).map(p => (
                        <button key={p} role="tab" aria-selected={wp === p} className={p === parity ? 'seg--today' : ''} onClick={() => setWp(p)}>
                            {p === 'odd' ? 'Нечётная' : 'Чётная'}
                        </button>
                    ))}
                </div>
            )}
            <p className="hint">
                {locked ? 'День уже прошёл — изменить нельзя.'
                    : mode === 'week' ? 'Только на эту неделю. «Нет пары» в предмете — пара отменена.'
                    : `Пары ${wp === 'odd' ? 'нечётной' : 'чётной'} недели. Без отметки «Только…» пара идёт каждую неделю.`}
            </p>
            {!locked && dayFilled.length > 0 && <div>{remoteChip('Весь день дистант', dayRemote, toggleDay)}</div>}

            <fieldset className="day-rows se-rows" disabled={locked}>
                {mode === 'week' ? slots.map(n => {
                    const f = week[day][n - 1], b = base(day, n), changed = !same(f, b);
                    // метка «замена» включается сама, если предмет, преподаватель или аудитория отличаются от расписания
                    const replaced = !same({ ...f, remote: false }, { ...b, remote: false });
                    return row(`${n}`, n, f, v => setSlot(n - 1, v), changed,
                        replaced && <span className="chip chip--tertiary se-mark">замена</span>,
                        changed && <button className="btn-icon btn-icon--neutral" title="Вернуть как было" aria-label="Вернуть как было" onClick={() => setSlot(n - 1, b)}><IcoUndo /></button>);
                }) : slots.flatMap(n => {
                    const slot = all.map((l, idx) => ({ l, idx })).filter(({ l }) => visible(l) && l.pair_no === n);
                    const busyOther = all.some(l => l.weekday === day + 1 && l.pair_no === n && l.parity === otherP);
                    // новая пара — каждую неделю, если в другой неделе слот свободен, иначе только эта
                    const add = (l: Partial<Lesson>) => setAll(a => [...a, { weekday: day + 1, pair_no: n, parity: busyOther ? wp : 'all', ...EMPTY, ...l }]);
                    // «Только эта неделя»: снять — пара станет каждую неделю, пара другой недели в этом слоте убирается
                    const toggleOnly = (idx: number, l: Lesson) => l.parity === wp
                        ? setAll(a => a.map((x, k) => (k === idx ? { ...x, parity: 'all' as const } : x)).filter(x => !(x.weekday === l.weekday && x.pair_no === n && x.parity === otherP)))
                        : setLesson(idx, { ...l, parity: wp });
                    // ключ по позиции в слоте: пустая строка, став парой, остаётся тем же полем
                    return slot.length === 0
                        ? [row(`${n}-0`, n, EMPTY, v => add(v), false)]
                        : slot.map(({ l, idx }, k) => row(`${n}-${k}`, n, l, v => setLesson(idx, { ...l, ...v }), false,
                            l.subject.trim() && remoteChip(wp === 'odd' ? 'Только нечётная' : 'Только чётная', l.parity === wp, () => toggleOnly(idx, l))));
                })}
            </fieldset>

            <div className="se-actions">
                <button className="btn btn--tonal" disabled={busy} onClick={onClose}>Отмена</button>
                <button className="btn btn--primary" disabled={busy} onClick={save}>Сохранить</button>
            </div>
            {sheet && <Picker {...sheet} onPick={sheet.set} onClose={() => setSheet(null)} />}
        </section>
    );
}

interface Item { title: string; sub: string }

// MD3 bottom sheet выбора: список в рамке, выбранный пункт залит; «+» — ввести новый вариант
function Picker({ title, hint, empty, value, items, onPick, onClose }: {
    title: string; hint: string; empty: string; value: string; items: Item[]; onPick: (v: string) => void; onClose: () => void;
}) {
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState('');
    // смахивание вниз с любого места шторки (со списка — только когда он прокручен в самый верх):
    // шторка тянется за пальцем, дальше 80px — закрывается
    const [dy, setDy] = useState(0);
    const startY = useRef<number | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    // закрытие с анимацией: шторка уезжает вниз, фон гаснет, потом размонтируется
    const [closing, setClosing] = useState(false);
    const close = () => { if (closing) return; setClosing(true); window.setTimeout(onClose, 260); };
    const closeRef = useRef(close);
    closeRef.current = close;
    useEffect(() => {
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
        document.addEventListener('keydown', key);
        return () => document.removeEventListener('keydown', key);
    }, []);
    const pick = (v: string) => { onPick(v); close(); };
    // значение, введённое вручную раньше, тоже показываем в списке
    const list = value && !items.some(i => i.title === value) ? [{ title: value, sub: '' }, ...items] : items;

    // в body: у карточки есть анимация transform, внутри неё fixed отсчитывался бы от карточки
    return createPortal(
        <div className="scrim-sheet" style={{ opacity: closing ? 0 : 1 - Math.min(dy / 500, 0.6) }}
             onClick={e => { if (e.target === e.currentTarget) close(); }}>
            <div className={`sheet${closing ? ' sheet--out' : ''}`} role="dialog" aria-modal="true" aria-labelledby="sheet-title"
                 style={dy && !closing ? { transform: `translateY(${dy}px)`, transition: 'none' } : undefined}
                 onTouchStart={e => { startY.current = (listRef.current?.scrollTop ?? 0) > 0 && listRef.current?.contains(e.target as Node) ? null : e.touches[0].clientY; }}
                 onTouchMove={e => { if (startY.current !== null) setDy(Math.max(0, e.touches[0].clientY - startY.current)); }}
                 onTouchEnd={() => { startY.current = null; if (dy > 80) close(); else setDy(0); }}>
                <div className="sheet-drag">
                    <button className="sheet-handle" aria-label="Закрыть" onClick={close} />
                    <div className="sheet-head">
                        <h2 className="sheet-title grow" id="sheet-title">{title}</h2>
                        <button className="sheet-add" aria-label="Добавить новый" aria-expanded={adding} onClick={() => setAdding(a => !a)}><IcoPlus /></button>
                    </div>
                </div>
                {adding ? (
                    <form className="sheet-new" onSubmit={e => { e.preventDefault(); if (draft.trim()) pick(draft.trim()); }}>
                        <label className="tf grow">
                            <input className="tf-in" placeholder=" " autoFocus maxLength={200} value={draft} onChange={e => setDraft(e.target.value)} />
                            <span className="tf-label">Новый вариант</span>
                        </label>
                        <button className="btn btn--primary" disabled={!draft.trim()}>Готово</button>
                    </form>
                ) : <p className="sheet-hint">{hint}</p>}
                <div className="sheet-group" ref={listRef}>
                    <button className={`sheet-item${value ? '' : ' sheet-item--sel'}`} onClick={() => pick('')}>
                        <span className="sheet-item-title">{empty}</span>
                    </button>
                    {list.map(i => (
                        <button key={i.title} className={`sheet-item${i.title === value ? ' sheet-item--sel' : ''}`} onClick={() => pick(i.title)}>
                            <span className="sheet-item-title">{i.title}</span>
                            {i.sub && <span className="sheet-item-sub">{i.sub}</span>}
                        </button>
                    ))}
                </div>
            </div>
        </div>,
        document.body,
    );
}
