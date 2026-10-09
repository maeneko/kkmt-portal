import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, cached, errText, isModerator, type Me, type OpenLesson } from '../../lib/api';
import { IcoPlus } from '../../components/icons';
import HomeworkBlock, { SOLUTION, hasContent, type HwItem } from './HomeworkBlock';
import TeacherInfo from './TeacherInfo';
import type { Lesson, PairTime, Teacher } from '.';

interface Data { lessons: Lesson[]; teachers?: Teacher[]; times: PairTime[]; satTimes?: PairTime[]; semesterStart: string | null }

// Подробности пары. Рисует App, а не страница: панель закреплена справа, а страница сдвигается влево; при смене вкладки закрывается.
// ПК — панель справа (страница сдвигается влево), телефон — шторка снизу.
export default function LessonDetails({ sel, closing, me, showMsg, onClose, onChanged }: {
    sel: OpenLesson; closing: boolean; me: Me; showMsg: (t: string) => void; onClose: () => void; onChanged: () => void;
}) {
    const [data, setData] = useState<Data | null>(() => cached<Data>('/schedule') ?? null);
    const [hw, setHw] = useState<Record<number, HwItem>>({});
    // пара («дата|номер»), у которой модератор открыл пустую зону «Эталонное решение»
    const [solOpen, setSolOpen] = useState('');
    const mod = isModerator(me);

    const loadData = useCallback(() => { api<Data>('GET', '/schedule').then(setData).catch(e => showMsg(errText(e))); }, [showMsg]);
    useEffect(() => { loadData(); }, [loadData]);
    // ДЗ, файлы и решение этой пары лежат в слотах этой даты: пара N и N + SOLUTION
    const loadHw = useCallback(() => {
        const url = `/homework?from=${sel.date}&to=${sel.date}`;
        const show = (d: { items: HwItem[] }) => setHw(Object.fromEntries(d.items.map(i => [i.pair_no, i])));
        const c = cached<{ items: HwItem[] }>(url);
        if (c) show(c);
        api<{ items: HwItem[] }>('GET', url).then(show).catch(e => showMsg(errText(e)));
    }, [sel.date, showMsg]);
    useEffect(() => { loadHw(); }, [loadHw]);
    const changed = () => { loadHw(); onChanged(); };

    const { pair_no: pair } = sel;
    // время пары: у субботы свои звонки (если заданы)
    const sat = sel.weekday === 6 && !!data?.satTimes?.length;
    const t = (sat ? data?.satTimes : data?.times)?.find(x => x.pair_no === pair);
    const slot = `${sel.date}|${pair}`, item = hw[pair], sol = hw[pair + SOLUTION];
    const hwProps = { date: sel.date, canEdit: mod, onChanged: changed, showMsg, subject: sel.subject, lessons: data?.lessons ?? [], semesterStart: data?.semesterStart ?? null };

    const info = (
        <>
            <dl className="lesson-info">
                <div className="li-wide"><dt>День</dt><dd>{sel.day}, {sel.date.slice(8)}.{sel.date.slice(5, 7)}</dd></div>
                <div><dt>Пара</dt><dd>{pair}{t ? ` · ${t.start_time}–${t.end_time}` : ''}</dd></div>
                <div><dt>Аудитория</dt><dd>{sel.room || '—'}</dd></div>
                {sel.teacher
                    ? <div className="li-wide li-teacher"><TeacherInfo name={sel.teacher} contact={data?.teachers?.find(x => x.name === sel.teacher)} canEdit={mod} onSaved={loadData} showMsg={showMsg} /></div>
                    : <div className="li-wide"><dt>Преподаватель</dt><dd>—</dd></div>}
            </dl>
            <HomeworkBlock {...hwProps} pair={pair} item={item} />
            {hasContent(sol) || mod && solOpen === slot
                ? <HomeworkBlock {...hwProps} pair={pair + SOLUTION} item={sol} />
                : mod && <button className="btn btn--tonal btn--sm hw-add-sol" onClick={() => setSolOpen(slot)}><IcoPlus /> Добавить эталонное решение</button>}
        </>
    );

    if (sel.pop) return (
        <aside className={`lesson-side${closing ? ' lesson-side--out' : ''}`} role="dialog" aria-labelledby="lesson-title">
            <div className="lesson-pop-head">
                <h2 className="lesson-pop-title" id="lesson-title">{sel.subject}</h2>
                <button className="btn-icon btn-icon--neutral" aria-label="Закрыть" onClick={onClose}>✕</button>
            </div>
            {info}
        </aside>
    );
    return <LessonSheet title={sel.subject} onClose={onClose}>{info}</LessonSheet>;
}

// Подробности пары на телефоне — шторка снизу: смахивание вниз за ручку и заголовок, нажатие на фон или ✕ закрывают.
function LessonSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
    const [dy, setDy] = useState(0);
    const startY = useRef<number | null>(null);
    // закрытие с анимацией: шторка уезжает вниз, фон гаснет, потом размонтируется
    const [closing, setClosing] = useState(false);
    const close = () => { if (closing) return; setClosing(true); window.setTimeout(onClose, 260); };
    return (
        <div className="scrim-sheet" style={{ opacity: closing ? 0 : 1 - Math.min(dy / 500, 0.6) }} onClick={e => { if (e.target === e.currentTarget) close(); }}>
            <div className={`sheet sheet--lesson${closing ? ' sheet--out' : ''}`} role="dialog" aria-modal="true" aria-labelledby="lesson-title"
                 style={dy && !closing ? { transform: `translateY(${dy}px)`, transition: 'none' } : undefined}>
                <div className="sheet-drag"
                     onTouchStart={e => { startY.current = e.touches[0].clientY; }}
                     onTouchMove={e => { if (startY.current !== null) setDy(Math.max(0, e.touches[0].clientY - startY.current)); }}
                     onTouchEnd={() => { startY.current = null; if (dy > 80) close(); else setDy(0); }}>
                    <button className="sheet-handle" aria-label="Закрыть" onClick={close} />
                    <div className="sheet-head">
                        <h2 className="sheet-title grow" id="lesson-title">{title}</h2>
                        <button className="btn-icon btn-icon--neutral" aria-label="Закрыть" onClick={close}>✕</button>
                    </div>
                </div>
                <div className="sheet-body">{children}</div>
            </div>
        </div>
    );
}
