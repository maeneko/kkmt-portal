import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, cached, clip, errText, isModerator, type Me } from '../../lib/api';
import Avatar from '../../components/Avatar';
import Linkify from '../../components/Linkify';
import { useConfirm } from '../../components/Dialog';
import { IcoChevron, IcoClip, IcoPlus, IcoTrash } from '../../components/icons';

type Status = 'open' | 'clarify' | 'accepted' | 'rejected' | 'done';
interface Event { id: number; status: Status; note: string; created_at: string; actor_name: string }
interface Idea { id: number; title: string; body: string; status: Status; has_image: boolean; created_at: string; author_id: number; author_name: string; author_photo: string | null; events: Event[] }

const STATUS: Record<Status, { label: string; chip: string }> = {
    open: { label: 'Открыта', chip: '' },
    clarify: { label: 'Нужны подробности', chip: ' chip--tertiary' },
    accepted: { label: 'Принята', chip: ' chip--primary' },
    rejected: { label: 'Отклонена', chip: ' chip--error' },
    done: { label: 'Реализована', chip: ' chip--online' },
};
// что модератор может сделать с идеей в её текущем статусе
const ACTIONS: Record<Status, [Status, string][]> = {
    open: [['clarify', 'Попросить объяснить подробнее'], ['accepted', 'Принять'], ['rejected', 'Отклонить']],
    clarify: [['accepted', 'Принять'], ['rejected', 'Отклонить']],
    accepted: [['done', 'Реализована'], ['rejected', 'Отклонить'], ['open', 'Вернуть в открытые']],
    rejected: [['open', 'Вернуть в открытые']],
    done: [['open', 'Вернуть в открытые']],
};

const fmt = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const Chip = ({ s }: { s: Status }) => <span className={`chip${STATUS[s].chip}`}>{STATUS[s].label}</span>;

// Идеи группы. Любой предлагает идею; модераторы принимают, отклоняют и отмечают реализованными.
// Каждая смена статуса попадает в журнал под идеей — как таймлайн задачи в GitHub.
export default function Ideas({ me, showMsg }: { me: Me; showMsg: (t: string) => void }) {
    const [ask, dialog] = useConfirm();
    const [ideas, setIdeas] = useState<Idea[]>(() => cached<Idea[]>('/ideas') ?? []);
    const [loaded, setLoaded] = useState(() => !!cached('/ideas'));
    const [open, setOpen] = useState<number | null>(null);
    const [adding, setAdding] = useState(false);
    // кнопка «Предложить идею» стоит в строке подзаголовка панели (гнездо head-action в Chat)
    const [slot, setSlot] = useState<HTMLElement | null>(null);
    useEffect(() => { setSlot(document.getElementById('head-action')); }, []);
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [note, setNote] = useState('');
    const [shot, setShot] = useState<File | null>(null);
    const picker = useRef<HTMLInputElement>(null);
    const preview = useMemo(() => shot && URL.createObjectURL(shot), [shot]);
    useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

    const load = useCallback(async () => {
        try { setIdeas(await api<Idea[]>('GET', '/ideas')); } catch (e) { showMsg(errText(e)); } finally { setLoaded(true); }
    }, [showMsg]);
    useEffect(() => { load(); }, [load]);

    const publish = async () => {
        try {
            const { id } = await api<{ id: number }>('POST', '/ideas', { title, body });
            setTitle(''); setBody(''); setAdding(false); setShot(null);
            // скриншот уходит отдельным запросом: если он не прошёл, идея всё равно создана
            if (shot) {
                const res = await fetch(`/api/ideas/${id}/image`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': shot.type }, body: shot });
                if (!res.ok) showMsg((await res.json().catch(() => ({}))).error ?? 'Не удалось прикрепить скриншот');
            }
            await load(); showMsg('Идея предложена');
        } catch (e) { showMsg(errText(e)); }
    };
    const setStatus = async (i: Idea, status: Status) => {
        try { await api('PATCH', `/ideas/${i.id}`, { status, note }); setNote(''); await load(); } catch (e) { showMsg(errText(e)); }
    };
    const reply = async (i: Idea) => {
        try { await api('POST', `/ideas/${i.id}/reply`, { note }); setNote(''); await load(); } catch (e) { showMsg(errText(e)); }
    };
    const remove = async (i: Idea) => {
        if (!await ask({ title: 'Удалить идею?', body: 'Идея и её журнал удалятся без возможности восстановления.', confirm: 'Удалить', danger: true })) return;
        try { await api('DELETE', `/ideas/${i.id}`); setIdeas(l => l.filter(x => x.id !== i.id)); setOpen(null); } catch (e) { showMsg(errText(e)); }
    };

    return (
        <>
            {adding ? (
                <div className="card" onPaste={e => { const f = [...e.clipboardData.files].find(f => f.type.startsWith('image/')); if (f) setShot(f); }}>
                    <span className="card-title">Новая идея</span>
                    <input className="field" placeholder="Название" maxLength={120} autoFocus value={title} onChange={e => setTitle(e.target.value)} />
                    <textarea className="field" placeholder="Подробности (необязательно)" maxLength={2000} value={body} onChange={e => setBody(e.target.value)} />
                    {preview && <img className="idea-shot" src={preview} alt="Скриншот" />}
                    <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e => { setShot(e.target.files?.[0] ?? null); e.target.value = ''; }} />
                    <div className="row row--wrap">
                        <button className="btn btn--ghost" onClick={() => shot ? setShot(null) : picker.current?.click()}>{shot ? <><IcoTrash /> Убрать скриншот</> : <><IcoClip /> Прикрепить скриншот</>}</button>
                        <span className="grow" /><button className="btn btn--ghost" onClick={() => { setAdding(false); setShot(null); }}>Отмена</button><button className="btn btn--primary" disabled={!title.trim()} onClick={publish}><IcoPlus /> Предложить</button></div>
                </div>
            ) : open === null && slot && createPortal(<button className="btn btn--primary btn--sm" onClick={() => setAdding(true)}><IcoPlus /> Предложить идею</button>, slot)}

            {loaded && ideas.length === 0 && <p className="empty">Идей пока нет — предложите первую</p>}

            {ideas.filter(i => open === null || i.id === open).map(i => open === null ? (
                <button key={i.id} className="card idea idea-head" onClick={() => setOpen(i.id)}>
                    <Avatar name={clip(i.author_name)} photo={i.author_photo} />
                    <span className="grow idea-title"><b>{i.title}</b><span className="hint">{clip(i.author_name)} · {fmt(i.created_at)}</span></span>
                    <Chip s={i.status} />
                </button>
            ) : (
                <article key={i.id} className="card idea">
                    <div className="row">
                        <button className="btn btn--ghost btn--sm idea-back" onClick={() => { setOpen(null); setNote(''); }}><IcoChevron /> Все идеи</button>
                        <span className="grow" />
                        {(isModerator(me) || i.author_id === me.id) && <button className="btn-icon btn-icon--danger" aria-label="Удалить идею" onClick={() => remove(i)}><IcoTrash /></button>}
                    </div>
                    <div className="row">
                        <Avatar name={clip(i.author_name)} photo={i.author_photo} />
                        <span className="grow idea-title"><b>{i.title}</b><span className="hint">{clip(i.author_name)} · {fmt(i.created_at)}</span></span>
                        <Chip s={i.status} />
                    </div>
                    {i.body && <div className="post-body"><Linkify text={i.body} /></div>}
                    {i.has_image && <a href={`/api/ideas/${i.id}/image`} target="_blank" rel="noreferrer"><img className="idea-shot" src={`/api/ideas/${i.id}/image`} alt="Скриншот" /></a>}
                    <ol className="log">
                        <li><i className="log-dot" /><span><b>{clip(i.author_name)}</b> предложил(а) идею</span><span className="hint">{fmt(i.created_at)}</span></li>
                        {i.events.map(e => (
                            <li key={e.id}>
                                <i className="log-dot" />
                                <span><b>{clip(e.actor_name) || 'Удалённый пользователь'}</b> <Chip s={e.status} />{e.note && <span className="log-note"><Linkify text={e.note} /></span>}</span>
                                <span className="hint">{fmt(e.created_at)}</span>
                            </li>
                        ))}
                    </ol>
                    {i.status === 'clarify' && i.author_id === me.id && (
                        <div className="row row--wrap">
                            <input className="field grow" placeholder="Ваш ответ" maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
                            <button className="btn btn--primary" disabled={!note.trim()} onClick={() => reply(i)}>Ответить</button>
                        </div>
                    )}
                    {isModerator(me) && (
                        <div className="row row--wrap">
                            <input className="field grow" placeholder="Комментарий или вопрос автору" maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
                            {ACTIONS[i.status].map(([s, label]) => <button key={s} className="btn btn--ghost" disabled={s === 'clarify' && !note.trim()} onClick={() => setStatus(i, s)}>{label}</button>)}
                        </div>
                    )}
                </article>
            ))}
            {dialog}
        </>
    );
}
