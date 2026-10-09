import { useCallback, useEffect, useState } from 'react';
import { api, errText, isModerator, type PageProps } from '../../lib/api';
import { IcoCalendar, IcoChevron, IcoFolder, IcoPlus } from '../../components/icons';
import { subjectAt, type Lesson } from '../schedule';
import Linkify from '../../components/Linkify';
import HomeworkBlock, { FileList, GENERAL, LinkList, SOLUTION, hasContent, type HwItem } from '../schedule/HomeworkBlock';
import './materials.css';

interface Subject { name: string; items: HwItem[]; files: number; links: number }
type Sort = 'name' | 'date';

const GENERAL_NAME = 'Общие материалы';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const VIEW_KEY = 'kkmt.materialsView';
const SORT_KEY = 'kkmt.materialsSort';
const fmtDate = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });

// Все дз и файлы семестра в двух видах: карточки (предметы → страница предмета с карточками дней)
// и список-дерево (Предмет → День → файлы и задание, уровни сворачиваются).
// Дз хранится по дате и номеру пары, поэтому предмет находим по расписанию: день недели + чётность недели.
export default function Materials({ me, showMsg, goTo }: PageProps) {
    const [subjects, setSubjects] = useState<Subject[] | null>(null);
    // общие материалы — не привязаны ни к предмету, ни к дате
    const [general, setGeneral] = useState<HwItem | undefined>();
    const loadGeneral = useCallback(() => {
        api<{ items: HwItem[] }>('GET', `/homework?from=${GENERAL}&to=${GENERAL}`).then(d => setGeneral(d.items[0])).catch(e => showMsg(errText(e)));
    }, [showMsg]);
    useEffect(() => { loadGeneral(); }, [loadGeneral]);
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
    const [sort, setSortState] = useState<Sort>(() => {
        try { return localStorage.getItem(SORT_KEY) === 'date' ? 'date' : 'name'; } catch { return 'name'; }
    });
    const setSort = (v: Sort) => {
        setSortState(v);
        try { localStorage.setItem(SORT_KEY, v); } catch { /* не критично */ }
    };
    // открытый предмет в виде карточек
    const [cur, setCur] = useState<string | null>(null);

    // пара («дата|номер»), у которой модератор открыл пустую зону «Эталонное решение»
    const [solOpen, setSolOpen] = useState('');
    const load = useCallback(() => {
        (async () => {
            const sched = await api<{ lessons: Lesson[]; semesterStart: string | null }>('GET', '/schedule');
            const now = new Date();
            const from = sched.semesterStart ?? iso(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()));
            const to = iso(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()));
            const { items } = await api<{ items: HwItem[] }>('GET', `/homework?from=${from}&to=${to}`);
            // эталонные решения лежат отдельными слотами (пара + SOLUTION): подклеиваем к паре, у которой нет других материалов — создаём её
            const base = items.filter(i => i.pair_no <= SOLUTION);
            for (const sol of items.filter(i => i.pair_no > SOLUTION && hasContent(i))) {
                const pair = sol.pair_no - SOLUTION;
                let it = base.find(i => i.date === sol.date && i.pair_no === pair);
                if (!it) base.push(it = { date: sol.date, pair_no: pair, body: '', files: [], links: [] });
                it.solution = sol;
            }
            const map = new Map<string, Subject>();
            for (const it of base) {
                const name = subjectAt(sched.lessons, sched.semesterStart, it.date, it.pair_no) ?? 'Без предмета';
                const s = map.get(name) ?? { name, items: [], files: 0, links: 0 };
                s.items.push(it);
                s.files += it.files.length;
                s.links += it.links.length;
                map.set(name, s);
            }
            for (const s of map.values()) s.items.sort((a, b) => b.date.localeCompare(a.date) || a.pair_no - b.pair_no);
            setSubjects([...map.values()]);
        })().catch(e => showMsg(errText(e)));
    }, [showMsg]);
    useEffect(() => { load(); }, [load]);

    if (!subjects) return null;
    // «по дате» — предметы с самыми свежими материалами первыми; материалы внутри предмета всегда от новых к старым
    const shown = subjects.filter(s => s.name.toLowerCase().includes(query.trim().toLowerCase()))
        .sort((a, b) => (sort === 'date' ? b.items[0].date.localeCompare(a.items[0].date) : 0) || a.name.localeCompare(b.name, 'ru'));
    const summary = (s: Subject) => {
        const hw = s.items.filter(i => i.body).length;
        return [hw > 0 && `Заданий: ${hw}`, s.files > 0 && `Файлов: ${s.files}`, s.links > 0 && `Ссылок: ${s.links}`].filter(Boolean).join(' · ');
    };
    const showGeneral = GENERAL_NAME.toLowerCase().includes(query.trim().toLowerCase());
    const generalSummary = [general?.body && 'есть описание', general?.files.length && `Файлов: ${general.files.length}`, general?.links.length && `Ссылок: ${general.links.length}`].filter(Boolean).join(' · ');
    const generalBlock = (
        <HomeworkBlock date={GENERAL} pair={0} item={general} canEdit={isModerator(me)} onChanged={loadGeneral} showMsg={showMsg} subject="" lessons={[]} semesterStart={null} />
    );
    // содержимое дня — общее для обоих видов: сверху файлы, снизу задание, кнопка перехода в расписание
    const dayBody = (i: HwItem, label: string) => (
        <>
            {(i.files.length > 0 || i.links.length > 0) && (
                <div className="mat-zone mat-zone--files">
                    <span className="mat-zone-title">{[i.files.length > 0 && `Файлы · ${i.files.length}`, i.links.length > 0 && `Ссылки · ${i.links.length}`].filter(Boolean).join(' · ')}</span>
                    {i.files.length > 0 && <FileList files={i.files} />}
                    {i.links.length > 0 && <LinkList links={i.links} />}
                </div>
            )}
            {i.body && (
                <div className="mat-zone">
                    <span className="mat-zone-title">Задание</span>
                    <p className="hw-body"><Linkify text={i.body} /></p>
                </div>
            )}
            {isModerator(me) ? (
                // модератор правит решение на месте; пустое — кнопка-зона для добавления
                hasContent(i.solution) || solOpen === `${i.date}|${i.pair_no}`
                    ? <HomeworkBlock date={i.date} pair={i.pair_no + SOLUTION} item={i.solution} canEdit onChanged={load} showMsg={showMsg} subject="" lessons={[]} semesterStart={null} />
                    : <button className="btn btn--tonal btn--sm hw-add-sol" onClick={() => setSolOpen(`${i.date}|${i.pair_no}`)}><IcoPlus /> Добавить эталонное решение</button>
            ) : hasContent(i.solution) && i.solution && (
                <div className="mat-zone mat-zone--solution">
                    <span className="mat-zone-title">Эталонное решение</span>
                    {i.solution.body && <p className="hw-body"><Linkify text={i.solution.body} /></p>}
                    {i.solution.files.length > 0 && <FileList files={i.solution.files} />}
                    {i.solution.links.length > 0 && <LinkList links={i.solution.links} />}
                </div>
            )}
            <button className="chip chip--primary mat-date" title="Открыть в расписании" onClick={() => goTo('schedule', { date: i.date, pair: i.pair_no })}>
                <IcoCalendar />{label}
            </button>
        </>
    );
    const page = subjects.find(s => s.name === cur);

    // Карточки: страница общих материалов
    if (view === 'cards' && cur === GENERAL_NAME) return (
        <div className="stack">
            <div className="mat-bar">
                <button className="btn-icon btn-icon--neutral mat-back" aria-label="Назад к предметам" onClick={() => setCur(null)}><IcoChevron /></button>
                <h3 className="mat-page-title grow">{GENERAL_NAME}</h3>
            </div>
            <section className="card">{generalBlock}</section>
        </div>
    );

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
                <div className="seg" role="tablist" aria-label="Сортировка предметов">
                    <button role="tab" aria-selected={sort === 'name'} onClick={() => setSort('name')}>По названию</button>
                    <button role="tab" aria-selected={sort === 'date'} onClick={() => setSort('date')}>По дате</button>
                </div>
                <div className="seg" role="tablist" aria-label="Вид материалов">
                    <button role="tab" aria-selected={view === 'cards'} onClick={() => setView('cards')}>Карточки</button>
                    <button role="tab" aria-selected={view === 'tree'} onClick={() => setView('tree')}>Список</button>
                </div>
            </div>
            {shown.length === 0 && !showGeneral && <p className="empty">{subjects.length ? 'Ничего не найдено' : 'Материалов пока нет'}</p>}

            {view === 'cards' && (
                <div className="mat-grid">
                    {showGeneral && (
                        <button className="card mat-card" onClick={() => { setCur(GENERAL_NAME); window.scrollTo(0, 0); }}>
                            <span className="mat-icon"><IcoFolder /></span>
                            <span className="mat-card-title">{GENERAL_NAME}</span>
                            <span className="tree-sub mat-sub--bottom">{generalSummary || 'Пока пусто'}</span>
                        </button>
                    )}
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

            {view === 'tree' && (shown.length > 0 || showGeneral) && (
                <ul className="card tree">
                    {showGeneral && (
                        <li>
                            <button className="tree-row tree-row--subj" aria-expanded={open.has(GENERAL_NAME)} onClick={() => flip(GENERAL_NAME)}>
                                <span className="tree-chev"><IcoChevron /></span>
                                <span className="mat-icon"><IcoFolder /></span>
                                <span className="grow">
                                    <span className="tree-title">{GENERAL_NAME}</span>
                                    <span className="tree-sub">{generalSummary || 'Пока пусто'}</span>
                                </span>
                            </button>
                            {open.has(GENERAL_NAME) && <div className="tree-leaf">{generalBlock}</div>}
                        </li>
                    )}
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
                                                            <span className="tree-sub">{[i.files.length > 0 && `Файлов: ${i.files.length}`, i.links.length > 0 && `Ссылок: ${i.links.length}`, i.body && 'есть задание'].filter(Boolean).join(' · ')}</span>
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
