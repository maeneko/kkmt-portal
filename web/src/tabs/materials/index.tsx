import { useEffect, useState } from 'react';
import { api, errText, type PageProps } from '../../lib/api';
import { IcoCalendar, IcoChevron, IcoFolder } from '../../components/icons';
import { subjectAt, type Lesson } from '../schedule';
import { FileList, type HwItem } from '../schedule/HomeworkBlock';
import './materials.css';

interface Subject { name: string; items: HwItem[]; files: number }

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const VIEW_KEY = 'kkmt.materialsView';
const fmtDate = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });

// Все дз и файлы семестра в двух видах: карточки (предметы → страница предмета с карточками дней)
// и список-дерево (Предмет → День → файлы и задание, уровни сворачиваются).
// Дз хранится по дате и номеру пары, поэтому предмет находим по расписанию: день недели + чётность недели.
export default function Materials({ showMsg, goTo }: PageProps) {
    const [subjects, setSubjects] = useState<Subject[] | null>(null);
    // раскрытые предметы и дни («предмет|дата|пара»)
    const [open, setOpen] = useState<Set<string>>(new Set());
    const flip = (k: string) => setOpen(o => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
    const [query, setQuery] = useState('');
    const [view, setViewState] = useState<'cards' | 'tree'>(() => {
        try { return localStorage.getItem(VIEW_KEY) === 'tree' ? 'tree' : 'cards'; } catch { return 'cards'; }
    });
    const setView = (v: 'cards' | 'tree') => {
        setViewState(v);
        try { localStorage.setItem(VIEW_KEY, v); } catch { /* не критично */ }
    };
    // открытый предмет в виде карточек
    const [cur, setCur] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            const sched = await api<{ lessons: Lesson[]; semesterStart: string | null }>('GET', '/schedule');
            const now = new Date();
            const from = sched.semesterStart ?? iso(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()));
            const to = iso(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()));
            const { items } = await api<{ items: HwItem[] }>('GET', `/homework?from=${from}&to=${to}`);
            const map = new Map<string, Subject>();
            for (const it of items) {
                const name = subjectAt(sched.lessons, sched.semesterStart, it.date, it.pair_no) ?? 'Без предмета';
                const s = map.get(name) ?? { name, items: [], files: 0 };
                s.items.push(it);
                s.files += it.files.length;
                map.set(name, s);
            }
            for (const s of map.values()) s.items.sort((a, b) => b.date.localeCompare(a.date) || a.pair_no - b.pair_no);
            setSubjects([...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')));
        })().catch(e => showMsg(errText(e)));
    }, [showMsg]);

    if (!subjects) return null;
    const shown = subjects.filter(s => s.name.toLowerCase().includes(query.trim().toLowerCase()));
    const summary = (s: Subject) => {
        const hw = s.items.filter(i => i.body).length;
        return [hw > 0 && `Заданий: ${hw}`, s.files > 0 && `Файлов: ${s.files}`].filter(Boolean).join(' · ');
    };
    // содержимое дня — общее для обоих видов: сверху файлы, снизу задание, кнопка перехода в расписание
    const dayBody = (i: HwItem, label: string) => (
        <>
            {i.files.length > 0 && (
                <div className="mat-zone mat-zone--files">
                    <span className="mat-zone-title">Файлы · {i.files.length}</span>
                    <FileList files={i.files} />
                </div>
            )}
            {i.body && (
                <div className="mat-zone">
                    <span className="mat-zone-title">Задание</span>
                    <p className="hw-body">{i.body}</p>
                </div>
            )}
            <button className="chip chip--primary mat-date" title="Открыть в расписании" onClick={() => goTo('schedule', { date: i.date, pair: i.pair_no })}>
                <IcoCalendar />{label}
            </button>
        </>
    );
    const page = subjects.find(s => s.name === cur);

    // Карточки: страница предмета — квадратные карточки дней
    if (view === 'cards' && page) return (
        <div className="stack">
            <div className="mat-bar">
                <button className="btn-icon btn-icon--neutral mat-back" aria-label="Назад к предметам" onClick={() => setCur(null)}><IcoChevron /></button>
                <div className="grow">
                    <h3 className="mat-page-title">{page.name}</h3>
                    <span className="tree-sub">{summary(page)}</span>
                </div>
            </div>
            <div className="mat-days">
                {page.items.map(i => (
                    <section key={`${i.date}|${i.pair_no}`} className="card mat-item">
                        {dayBody(i, `${fmtDate(i.date)} · ${i.pair_no} пара`)}
                    </section>
                ))}
            </div>
        </div>
    );

    return (
        <div className="stack">
            <div className="mat-top">
                <input className="field mat-search" type="search" placeholder="Поиск предмета" value={query} onChange={e => setQuery(e.target.value)} />
                <div className="seg" role="tablist" aria-label="Вид материалов">
                    <button role="tab" aria-selected={view === 'cards'} onClick={() => setView('cards')}>Карточки</button>
                    <button role="tab" aria-selected={view === 'tree'} onClick={() => setView('tree')}>Список</button>
                </div>
            </div>
            {shown.length === 0 && <p className="empty">{subjects.length ? 'Ничего не найдено' : 'Материалов пока нет'}</p>}

            {view === 'cards' && (
                <div className="mat-grid">
                    {shown.map(s => (
                        <button key={s.name} className="card mat-card" onClick={() => { setCur(s.name); window.scrollTo(0, 0); }}>
                            <span className="mat-icon"><IcoFolder /></span>
                            <span className="mat-card-title">{s.name}</span>
                            <span className="tree-sub mat-sub--bottom">{summary(s)}</span>
                            <span className="tree-sub">Последнее: {fmtDate(s.items[0].date)}</span>
                        </button>
                    ))}
                </div>
            )}

            {view === 'tree' && shown.length > 0 && (
                <ul className="card tree">
                    {shown.map(s => {
                        const so = open.has(s.name);
                        return (
                            <li key={s.name}>
                                <button className="tree-row tree-row--subj" aria-expanded={so} onClick={() => flip(s.name)}>
                                    <span className="tree-chev"><IcoChevron /></span>
                                    <span className="mat-icon"><IcoFolder /></span>
                                    <span className="grow">
                                        <span className="tree-title">{s.name}</span>
                                        <span className="tree-sub">{summary(s)}</span>
                                    </span>
                                </button>
                                {so && (
                                    <ul className="tree-children">
                                        {s.items.map(i => {
                                            const k = `${s.name}|${i.date}|${i.pair_no}`, d = open.has(k);
                                            return (
                                                <li key={k}>
                                                    <button className="tree-row" aria-expanded={d} onClick={() => flip(k)}>
                                                        <span className="tree-chev"><IcoChevron /></span>
                                                        <span className="grow">
                                                            <span className="tree-title">{fmtDate(i.date)} · {i.pair_no} пара</span>
                                                            <span className="tree-sub">{[i.files.length > 0 && `Файлов: ${i.files.length}`, i.body && 'есть задание'].filter(Boolean).join(' · ')}</span>
                                                        </span>
                                                    </button>
                                                    {d && <div className="tree-leaf">{dayBody(i, 'В расписании')}</div>}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
