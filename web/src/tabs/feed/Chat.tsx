import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, cached, clip, errText, isModerator, type Me } from '../../lib/api';
import Avatar from '../../components/Avatar';
import Logo from '../../components/Logo';
import Linkify from '../../components/Linkify';
import { useConfirm } from '../../components/Dialog';
import { IcoMegaphone, IcoMenu, IcoTrash, IcoUsers } from '../../components/icons';

interface Msg { id: number; channel: string; body: string; created_at: string; author_id: number; author_name: string; author_photo: string | null; pending?: boolean }
export interface Channel { name: string; unread: number }
type Page = { messages: Msg[]; hasMore: boolean };

// Новости (глобальные и группы) — не чаты, а ленты постов в той же панели (на сервер эти ключи не уходят)
const NEWS = { '@global': { title: 'Глобальные новости', scope: 'global', Icon: IcoMegaphone }, '@group': { title: 'Новости группы', scope: 'group', Icon: IcoUsers } } as const;
type NewsKey = keyof typeof NEWS;
const isNews = (c: string): c is NewsKey => c in NEWS;
const title = (c: string) => c || 'Общий';
const msgsUrl = (c: string) => `/chat/messages?channel=${encodeURIComponent(c)}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => {
    const d = new Date(iso), today = new Date();
    const y = new Date(today); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Сегодня';
    if (d.toDateString() === y.toDateString()) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};

// Лента как в Discord: слева каналы — новости (news рисует ленту постов) и чат «Общий», справа выбранный.
// Новые сообщения приходят сразу (SSE /api/chat/stream); после обрыва связи пропущенное догружается.
export default function Chat({ me, group, showMsg, news }: { me: Me; group: string; showMsg: (t: string) => void; news: (scope: 'global' | 'group') => ReactNode }) {
    const [ask, dialog] = useConfirm();
    const [channels, setChannels] = useState<Channel[]>(() => cached<Channel[]>('/chat') ?? [{ name: '', unread: 0 }]);
    // лента всегда открывается на глобальных новостях; выбранный канал не запоминается
    const [cur, setCur] = useState<string>('@global');
    const [page, setPage] = useState<Page>(() => cached<Page>(msgsUrl(cur)) ?? { messages: [], hasMore: false });
    const msgs = page.messages;
    const [draft, setDraft] = useState('');
    // телефон: каналы — шторка слева; открывается кнопкой в шапке или свайпом вправо по панели, закрывается выбором, фоном или свайпом влево
    const [drawer, setDrawer] = useState(false);
    const touch = useRef<{ x: number; y: number } | null>(null);
    const swipe = (open: boolean) => ({
        // от самого края не ловим: там системный жест «назад»
        onTouchStart: (e: React.TouchEvent) => { const t = e.touches[0]; touch.current = t.clientX > 24 ? { x: t.clientX, y: t.clientY } : null; },
        onTouchEnd: (e: React.TouchEvent) => {
            if (!touch.current) return;
            const t = e.changedTouches[0], dx = t.clientX - touch.current.x, dy = t.clientY - touch.current.y;
            touch.current = null;
            if (Math.abs(dx) > 60 && Math.abs(dy) < Math.abs(dx) / 2 && dx > 0 === open) setDrawer(open);
        },
    });
    const pick = (c: string) => { setCur(c); setDrawer(false); };
    const unreadElsewhere = channels.some(c => c.name !== cur && c.unread > 0);
    // подзаголовок — название канала; кнопка «три полоски» стоит в строке заголовка страницы (гнездо title-slot в App)
    const head = (text: string) => <div className="chat-head">{text}</div>;
    const [slot, setSlot] = useState<HTMLElement | null>(null);
    useEffect(() => { setSlot(document.getElementById('title-slot')); }, []);
    const menuBtn = slot && createPortal(
        <button className="btn-icon btn-icon--neutral chat-menu-btn" aria-label="Каналы" onClick={() => setDrawer(true)}>
            <IcoMenu />{unreadElsewhere && <i className="chat-head-dot" />}
        </button>, slot);
    const list = useRef<HTMLDivElement>(null);
    // поток событий видит актуальные канал и сообщения через ref (подписка одна на всё время)
    const curRef = useRef(cur); curRef.current = cur;
    const lastId = msgs.filter(m => !m.pending).at(-1)?.id ?? 0;
    const lastRef = useRef(lastId); lastRef.current = lastId;
    // прокрутка: у низа — держимся низа; подгрузили ранние — сохраняем место
    const atBottom = useRef(true);
    const keep = useRef<number | null>(null);

    const loadChannels = useCallback(() => { api<Channel[]>('GET', '/chat').then(setChannels).catch(e => showMsg(errText(e))); }, [showMsg]);
    useEffect(() => { loadChannels(); }, [loadChannels]);

    // открыли канал: сначала сохранённое, потом свежее
    useEffect(() => {
        setPage(cached<Page>(msgsUrl(cur)) ?? { messages: [], hasMore: false });
        atBottom.current = true;
        if (isNews(cur)) return;
        api<Page>('GET', msgsUrl(cur)).then(p => { if (curRef.current === cur) setPage(p); }).catch(e => showMsg(errText(e)));
    }, [cur, showMsg]);

    useEffect(() => {
        const es = new EventSource('/api/chat/stream');
        let first = true;
        // переподключились после обрыва: догружаем пропущенное и счётчики
        es.onopen = () => {
            if (first) { first = false; return; }
            loadChannels();
            const c = curRef.current;
            if (lastRef.current) api<Page>('GET', `${msgsUrl(c)}&after=${lastRef.current}`)
                .then(p => { if (curRef.current === c) setPage(old => ({ ...old, messages: [...old.messages, ...p.messages.filter(n => !old.messages.some(o => o.id === n.id))] })); })
                .catch(() => { /* следующая попытка — при новом переподключении */ });
        };
        es.onmessage = e => {
            const d = JSON.parse(e.data) as { message?: Msg; deleted?: number; channel?: string };
            if (d.message) {
                const m = d.message;
                if (m.channel === curRef.current) setPage(old => old.messages.some(o => o.id === m.id) ? old : { ...old, messages: [...old.messages, m] });
                else if (m.author_id !== me.id) setChannels(l => l.map(c => c.name === m.channel ? { ...c, unread: c.unread + 1 } : c));
            }
            if (d.deleted && d.channel === curRef.current) setPage(old => ({ ...old, messages: old.messages.filter(o => o.id !== d.deleted) }));
        };
        return () => es.close();
    }, [me.id, loadChannels]);

    // всё, что видно в открытом канале, — прочитано
    useEffect(() => {
        if (!lastId) return;
        const read = () => {
            if (document.visibilityState !== 'visible') return;
            setChannels(l => l.map(c => c.name === cur ? { ...c, unread: 0 } : c));
            api('PUT', '/chat/read', { channel: cur, last_id: lastId }).catch(() => { /* не критично */ });
        };
        read();
        document.addEventListener('visibilitychange', read);
        return () => document.removeEventListener('visibilitychange', read);
    }, [cur, lastId]);

    useLayoutEffect(() => {
        const el = list.current;
        if (!el) return;
        if (keep.current !== null) { el.scrollTop = el.scrollHeight - keep.current; keep.current = null; }
        else if (atBottom.current) el.scrollTop = el.scrollHeight;
    }, [msgs]);

    const older = async () => {
        try {
            const p = await api<Page>('GET', `${msgsUrl(cur)}&before=${msgs[0].id}`);
            keep.current = list.current ? list.current.scrollHeight - list.current.scrollTop : null;
            setPage(old => ({ messages: [...p.messages, ...old.messages], hasMore: p.hasMore }));
        } catch (e) { showMsg(errText(e)); }
    };

    // отправка: сообщение видно сразу (бледным), настоящее подменяет его, когда сервер ответил
    const send = async () => {
        const body = draft.trim();
        if (!body) return;
        const temp: Msg = { id: -Date.now(), channel: cur, body, created_at: new Date().toISOString(), author_id: me.id, author_name: me.display_name || me.first_name, author_photo: me.photo_url, pending: true };
        atBottom.current = true;
        setPage(old => ({ ...old, messages: [...old.messages, temp] }));
        setDraft('');
        try {
            const m = await api<Msg>('POST', '/chat/messages', { channel: cur, body });
            setPage(old => ({ ...old, messages: old.messages.some(o => o.id === m.id) ? old.messages.filter(o => o.id !== temp.id) : old.messages.map(o => o.id === temp.id ? m : o) }));
        } catch (e) {
            setPage(old => ({ ...old, messages: old.messages.filter(o => o.id !== temp.id) }));
            setDraft(body);
            showMsg(errText(e));
        }
    };

    const remove = async (m: Msg) => {
        if (!await ask({ title: 'Удалить сообщение?', body: 'Оно пропадёт у всех.', confirm: 'Удалить', danger: true })) return;
        try { await api('DELETE', `/chat/messages/${m.id}`); setPage(old => ({ ...old, messages: old.messages.filter(o => o.id !== m.id) })); }
        catch (e) { showMsg(errText(e)); }
    };

    return (
        <div className={`chat${drawer ? ' chat--drawer' : ''}`}>
            {menuBtn}
            <div className="chat-scrim" onClick={() => setDrawer(false)} />
            <nav className="chat-channels" aria-label="Каналы" {...swipe(false)}>
                {/* капсула группы: на телефоне она уезжает сюда из шапки, пока открыта лента */}
                <div className="brand-capsule chat-brand">
                    <Logo size={28} />
                    <span className="brand-text"><span className="brand-name">{group}</span><span className="brand-sub">Портал группы</span></span>
                </div>
                {Object.entries(NEWS).map(([k, n]) => (
                    <button key={k} className="chat-ch" aria-current={cur === k} onClick={() => pick(k)}>
                        <span className="chat-ch-hash"><n.Icon /></span><span className="chat-ch-name">{n.title}</span>
                    </button>
                ))}
                <hr className="chat-sep" />
                {channels.map(c => (
                    <button key={c.name} className="chat-ch" aria-current={c.name === cur} title={title(c.name)} onClick={() => pick(c.name)}>
                        <span className="chat-ch-hash">#</span><span className="chat-ch-name">{title(c.name)}</span>
                        {c.unread > 0 && c.name !== cur && <span className="chat-count">{c.unread}</span>}
                    </button>
                ))}
            </nav>
            {isNews(cur) ? (
                <section className="chat-pane" {...swipe(true)}>
                    {head(NEWS[cur].title)}
                    <div className="chat-news">{news(NEWS[cur].scope)}</div>
                </section>
            ) : (
            <section className="chat-pane" {...swipe(true)}>
                {head(`# ${title(cur)}`)}
                <div className="chat-list" ref={list} onScroll={e => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
                    {page.hasMore && <button className="btn btn--ghost btn--sm chat-older" onClick={older}>Показать ранние</button>}
                    {msgs.length === 0 && <p className="chat-empty">Сообщений пока нет — напишите первым</p>}
                    {msgs.map((m, i) => {
                        const prev = msgs[i - 1];
                        const newDay = !prev || day(prev.created_at) !== day(m.created_at);
                        // подряд от одного автора в пределах 5 минут — без повтора имени и аватарки
                        const head = newDay || prev.author_id !== m.author_id || +new Date(m.created_at) - +new Date(prev.created_at) > 5 * 60_000;
                        const canDelete = !m.pending && (m.author_id === me.id || isModerator(me));
                        return (
                            <div key={m.id}>
                                {newDay && <div className="chat-day"><span>{day(m.created_at)}</span></div>}
                                <div className={`msg${head ? ' msg--head' : ''}${m.pending ? ' msg--pending' : ''}`}>
                                    <div className="msg-side">{head ? <Avatar name={clip(m.author_name)} photo={m.author_photo} /> : <span className="msg-time">{time(m.created_at)}</span>}</div>
                                    <div className="msg-main">
                                        {head && <div className="msg-meta"><b title={m.author_name}>{clip(m.author_name)}</b><span>{time(m.created_at)}</span></div>}
                                        <div className="msg-body"><Linkify text={m.body} /></div>
                                    </div>
                                    {canDelete && <button className="btn-icon btn-icon--danger msg-del" aria-label="Удалить сообщение" onClick={() => remove(m)}><IcoTrash /></button>}
                                </div>
                            </div>
                        );
                    })}
                </div>
                <form className="chat-compose" onSubmit={e => { e.preventDefault(); send(); }}>
                    <textarea className="field" rows={1} maxLength={2000} placeholder={`Сообщение в #${title(cur)}`} value={draft}
                              ref={el => { if (el) { el.style.height = '0'; el.style.height = `${Math.min(el.scrollHeight + 2, 160)}px`; } }}
                              onChange={e => setDraft(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
                    <button className="btn btn--primary" disabled={!draft.trim()}>Отправить</button>
                </form>
            </section>
            )}
            {dialog}
        </div>
    );
}
