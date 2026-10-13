import { useEffect, useRef, useState } from 'react';
import { api, errText } from '../../lib/api';
import Avatar from '../../components/Avatar';
import Checkbox from '../../components/Checkbox';
import { IcoCheck, IcoUsers } from '../../components/icons';
import { subjectAt, type Lesson, type LessonChange, type PairTime } from '../schedule';
import { LessonSheet } from '../schedule/LessonDetails';

interface Sched { lessons: Lesson[]; changes?: LessonChange[]; times: PairTime[]; satTimes?: PairTime[]; semesterStart: string | null }
// человек из списка группы; user_id есть, если он уже зарегистрировался
interface Member { id: number; name: string; user_id?: number; holder?: string; nick?: string; photo?: string }
interface Mark { pair_no: number; roster_id: number; present: boolean }

const pad = (n: number) => String(n).padStart(2, '0');
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
// предмет пары на дату: замена важнее постоянного расписания; пустой — пары нет
const subjectOf = (s: Sched, date: string, n: number) => {
    const ch = s.changes?.find(c => c.date === date && c.pair_no === n);
    return ch ? ch.subject : subjectAt(s.lessons, s.semesterStart, date, n);
};
// звонки пары: у субботы свои, если заданы
const timeOf = (s: Sched, weekday: number, n: number) => (weekday === 6 && s.satTimes?.length ? s.satTimes : s.times).find(x => x.pair_no === n);
const pairsOf = (s: Sched, date: string) => Array.from({ length: 12 }, (_, i) => i + 1).filter(n => subjectOf(s, date, n));

// Кнопка «Посещаемость» в ленте (для старосты и выше): отмечаем, кто был на паре сегодня. По умолчанию не выбран никто.
export default function Attendance({ showMsg }: { showMsg: (t: string) => void }) {
    // ПК: панель почти на всю страницу, телефон: высокая шторка снизу (как подробности пары)
    const [open, setOpen] = useState(false);
    const [closing, setClosing] = useState(false);
    const [pop, setPop] = useState(true);
    const [sched, setSched] = useState<Sched | null>(null);
    const [members, setMembers] = useState<Member[]>([]);
    const [marks, setMarks] = useState<Mark[]>([]);
    const [pair, setPair] = useState(0);
    // кто на паре: по умолчанию никто, староста отмечает присутствующих (если пара уже отмечена — как было сохранено)
    const [present, setPresent] = useState<Set<number>>(new Set());
    // отправка: список сворачивается, кнопка превращается в поле со «крутилкой», потом «Отправлено» и панель закрывается
    const [phase, setPhase] = useState<'idle' | 'sending' | 'done'>('idle');
    const [error, setError] = useState(''); // «некому отправить» и сбой доставки: в шторке snackbar закрыт затемнением, поэтому показываем в самом окне
    // выпадающий список пар
    const [menu, setMenu] = useState(false);
    const [menuOut, setMenuOut] = useState(false);
    const pairBox = useRef<HTMLDivElement>(null);
    // закрытие с анимацией: меню сворачивается, потом размонтируется
    const closeMenu = () => { setMenuOut(true); window.setTimeout(() => { setMenu(false); setMenuOut(false); }, 140); };

    const now = new Date();
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const weekday = (now.getDay() + 6) % 7 + 1; // 1 = Пн

    const pairs = sched ? pairsOf(sched, date) : [];
    const minutes = now.getHours() * 60 + now.getMinutes();
    // пара, которая идёт прямо сейчас
    const nowPair = sched ? pairs.find(n => { const t = timeOf(sched, weekday, n); return t && toMin(t.start_time) <= minutes && minutes < toMin(t.end_time); }) : undefined;

    // отметки пары → множество присутствующих (без отметок не выбран никто)
    const pick = (n: number, all: Mark[]) => { setPair(n); setPresent(new Set(all.filter(m => m.pair_no === n && m.present).map(m => m.roster_id))); };

    const close = () => { setClosing(true); window.setTimeout(() => { setOpen(false); setClosing(false); }, 260); };
    const show = async () => {
        setPop(window.matchMedia('(min-width: 641px)').matches);
        setClosing(false); setPhase('idle'); setError(''); setOpen(true);
        try {
            const [s, u, m] = await Promise.all([api<Sched>('GET', '/schedule'), api<Member[]>('GET', '/roster'), api<Mark[]>('GET', `/attendance?date=${date}`)]);
            setSched(s); setMembers([...u].sort((x, y) => x.name.localeCompare(y.name, 'ru'))); setMarks(m); // по алфавиту (фамилия первой)
            // сначала пара, которая идёт сейчас или ещё впереди; если все закончились — последняя
            const today = pairsOf(s, date);
            const cur = today.find(n => { const t = timeOf(s, weekday, n); return t && toMin(t.end_time) > minutes; }) ?? today[today.length - 1] ?? 0;
            pick(cur, m);
        } catch (e) { showMsg(errText(e)); setOpen(false); }
    };

    useEffect(() => {
        if (!open || !pop) return;
        const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (menu) closeMenu(); else close(); } };
        document.addEventListener('keydown', h);
        return () => document.removeEventListener('keydown', h);
    }, [open, pop, menu]);
    // нажатие вне списка пар закрывает его
    useEffect(() => {
        if (!menu) return;
        const h = (e: MouseEvent) => { if (!pairBox.current?.contains(e.target as Node)) closeMenu(); };
        document.addEventListener('mousedown', h);
        return () => document.removeEventListener('mousedown', h);
    }, [menu]);

    const toggle = (id: number) => setPresent(a => { const n = new Set(a); if (!n.delete(id)) n.add(id); return n; });
    const save = async () => {
        setPhase('sending'); setError('');
        try {
            const list = members.map(m => ({ roster_id: m.id, present: present.has(m.id) }));
            // не короче 900 мс, чтобы отправка читалась, а не мигала
            await Promise.all([api('PUT', '/attendance', { date, pair_no: pair, subject: sched ? subjectOf(sched, date, pair) : '', marks: list }), new Promise(r => window.setTimeout(r, 900))]);
            setMarks(all => [...all.filter(m => m.pair_no !== pair), ...list.map(b => ({ ...b, pair_no: pair }))]);
            setPhase('done');
            window.setTimeout(() => { close(); showMsg('Посещаемость отправлена'); }, 800);
        } catch (e) { setError(errText(e)); setPhase('idle'); }
    };

    // доля присутствующих — полоска сверху
    const here = present.size;
    const bar = sched && pairs.length > 0 && (
        <div className="att-top">
            <div className="att-count"><span>Присутствуют</span><b>{here} из {members.length}</b></div>
            <div className="att-progress" role="progressbar" aria-label="Присутствуют" aria-valuemin={0} aria-valuemax={members.length} aria-valuenow={here}>
                <i style={{ width: `${members.length ? here / members.length * 100 : 0}%` }} />
            </div>
        </div>
    );
    const body = !sched ? <p className="hint">Загрузка…</p> : members.length === 0 ? <p className="hint">Список группы пуст: админ добавляет имена в админке, вкладка «Список»</p> : pairs.length === 0 ? <p className="hint">Сегодня пар нет</p> : (
        <div className={`att${phase === 'idle' ? '' : ' att--busy'}`}>
            <div className="tf" ref={pairBox}>
                <button type="button" className="tf-in tf-btn" disabled={phase !== 'idle'} aria-haspopup="listbox" aria-expanded={menu} onClick={() => (menu && !menuOut ? closeMenu() : setMenu(true))}>
                    {pair} пара · {subjectOf(sched, date, pair)}{pair === nowPair && <span className="chip chip--primary att-now">Сейчас</span>}
                </button>
                <span className="tf-label">Пара</span>
                {menu && (
                    <div className={`att-menu${menuOut ? ' att-menu--out' : ''}`} role="listbox" aria-label="Пара">
                        {pairs.map((n, i) => {
                            const t = timeOf(sched, weekday, n);
                            return (
                                <button type="button" key={n} role="option" aria-selected={n === pair} className={`att-opt${n === pair ? ' att-opt--sel' : ''}${n === nowPair ? ' att-opt--now' : ''}`}
                                        style={{ animationDelay: `${40 + i * 25}ms` }} onClick={() => { pick(n, marks); closeMenu(); }}>
                                    <span className="att-opt-no">{n}</span>
                                    <span className="grow att-opt-text"><b>{subjectOf(sched, date, n)}</b>{t && <small>{t.start_time}–{t.end_time}</small>}</span>
                                    {n === nowPair && <span className="chip chip--primary">Сейчас</span>}
                                    {n === pair && <IcoCheck />}
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
            <div className={`att-fold${phase === 'idle' ? '' : ' att-fold--shut'}`}>
                <div className="att-list">
                    {members.map(m => (
                        <label className="att-row" key={m.id}>
                            <Avatar name={m.name} photo={m.photo ?? null} />
                            <div className="grow">
                                <div className="nm" style={{ fontWeight: 500 }}>{m.name}</div>
                                <div className="hint nm">{m.user_id ? (m.nick ? `@${m.nick}` : m.holder) : 'Ещё не зарегистрирован'}</div>
                            </div>
                            <Checkbox checked={present.has(m.id)} onChange={() => toggle(m.id)} aria-label={`${m.name}: присутствует`} />
                        </label>
                    ))}
                </div>
            </div>
            {error && phase === 'idle' && <p className="login-error">{error}</p>}
            {phase === 'idle'
                ? <button className="att-go" onClick={save}>Отправить</button>
                : <div className="att-status" role="status">{phase === 'sending' ? <><span className="att-spin" />Отправляем…</> : <><IcoCheck />Отправлено</>}</div>}
        </div>
    );

    return (
        <>
            <div className="edit-dial">
                <button className="edit-dial-btn" aria-label="Отметить посещаемость" onClick={show}><IcoUsers /><span>Посещаемость</span></button>
            </div>
            {open && (pop
                ? (
                    <aside className={`att-page${phase !== 'idle' ? ' att-page--busy' : ''}${closing ? ' att-page--out' : ''}`} role="dialog" aria-labelledby="att-title">
                        <div className="lesson-pop-head">
                            <h2 className="lesson-pop-title" id="att-title">Посещаемость</h2>
                            <button className="btn-icon btn-icon--neutral" aria-label="Закрыть" onClick={close}>✕</button>
                        </div>
                        {bar}
                        {body}
                    </aside>
                )
                : <LessonSheet title="Посещаемость" out={closing} onClose={() => setOpen(false)}>{bar}{body}</LessonSheet>)}
        </>
    );
}
