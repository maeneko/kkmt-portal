import { useCallback, useEffect, useState } from 'react';
import { api, cached, clip, errText, isAdmin, type PageProps } from '../../lib/api';
import Avatar from '../../components/Avatar';
import Linkify from '../../components/Linkify';
import Switch from '../../components/Switch';
import { useConfirm } from '../../components/Dialog';
import { IcoPin, IcoPlus, IcoTrash } from '../../components/icons';
import './feed.css';

interface Post { id: number; body: string; pinned: boolean; created_at: string; author_id: number; author_name: string; author_photo: string | null }

const fmt = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

export default function Feed({ me, showMsg }: PageProps) {
    const [ask, dialog] = useConfirm();
    // прошлая лента из кеша — сразу, свежая подставится после загрузки
    const [posts, setPosts] = useState<Post[]>(() => cached<{ posts: Post[] }>('/posts')?.posts ?? []);
    const [hasMore, setHasMore] = useState(() => cached<{ hasMore: boolean }>('/posts')?.hasMore ?? false);
    const [loaded, setLoaded] = useState(() => !!cached('/posts'));
    const [draft, setDraft] = useState('');
    const [pinDraft, setPinDraft] = useState(false);

    const load = useCallback(async () => {
        try {
            const d = await api<{ posts: Post[]; hasMore: boolean }>('GET', '/posts');
            setPosts(d.posts); setHasMore(d.hasMore);
        } catch (e) { showMsg(errText(e)); } finally { setLoaded(true); }
    }, [showMsg]);
    useEffect(() => { load(); }, [load]);

    const more = async () => {
        const last = posts[posts.length - 1];
        try {
            const d = await api<{ posts: Post[]; hasMore: boolean }>('GET', `/posts?before=${last.id}`);
            setPosts(p => [...p, ...d.posts.filter(n => !p.some(o => o.id === n.id))]); setHasMore(d.hasMore);
        } catch (e) { showMsg(errText(e)); }
    };

    const publish = async () => {
        try { await api('POST', '/posts', { body: draft, pinned: pinDraft }); setDraft(''); setPinDraft(false); await load(); showMsg('Опубликовано'); }
        catch (e) { showMsg(errText(e)); }
    };
    const togglePin = async (p: Post) => {
        try { await api('PATCH', `/posts/${p.id}`, { pinned: !p.pinned }); await load(); } catch (e) { showMsg(errText(e)); }
    };
    const remove = async (p: Post) => {
        if (!await ask({ title: 'Удалить пост?', body: 'Пост удалится без возможности восстановления.', confirm: 'Удалить', danger: true })) return;
        try { await api('DELETE', `/posts/${p.id}`); setPosts(l => l.filter(x => x.id !== p.id)); } catch (e) { showMsg(errText(e)); }
    };

    return (
        <>
            {isAdmin(me) && (
                <div className="card">
                    <span className="card-title">Новый пост</span>
                    <textarea className="field" placeholder="Что нового для группы?" maxLength={5000} value={draft} onChange={e => setDraft(e.target.value)} />
                    <div className="row row--wrap">
                        <label className="choice grow"><span className="grow">Закрепить сверху</span><Switch checked={pinDraft} onChange={e => setPinDraft(e.target.checked)} /></label>
                        <button className="btn btn--primary" disabled={!draft.trim()} onClick={publish}><IcoPlus /> Опубликовать</button>
                    </div>
                </div>
            )}

            {loaded && posts.length === 0 && <p className="empty">Пока нет ни одного поста</p>}

            {posts.map(p => (
                <article key={p.id} className={`card post${p.pinned ? ' post--pinned' : ''}`}>
                    <div className="row">
                        <Avatar name={clip(p.author_name)} photo={p.author_photo} />
                        <div className="grow"><div className="nm" style={{ fontWeight: 500 }} title={p.author_name}>{clip(p.author_name)}</div><div className="hint">{fmt(p.created_at)}</div></div>
                        {p.pinned && <span className="chip chip--primary"><IcoPin /> Закреплено</span>}
                        {isAdmin(me) && (
                            <>
                                <button className="btn-icon btn-icon--neutral" aria-label={p.pinned ? 'Открепить' : 'Закрепить'} onClick={() => togglePin(p)}><IcoPin /></button>
                                <button className="btn-icon btn-icon--danger" aria-label="Удалить пост" onClick={() => remove(p)}><IcoTrash /></button>
                            </>
                        )}
                    </div>
                    <div className="post-body"><Linkify text={p.body} /></div>
                </article>
            ))}

            {hasMore && <button className="btn btn--ghost btn--full" onClick={more}>Показать ещё</button>}
            {dialog}
        </>
    );
}
