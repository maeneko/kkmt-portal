import { useCallback, useEffect, useState } from 'react';
import { api, cached, clip, errText } from '../../lib/api';
import Avatar from '../../components/Avatar';
import Linkify from '../../components/Linkify';
import { IcoBulb, IcoCalendar, IcoFolder, IcoNote, IcoUsers } from '../../components/icons';

interface Item { id: number; kind: string; text: string; created_at: string; actor_name: string; actor_photo: string | null }
type Page = { items: Item[]; hasMore: boolean };

const fmt = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
// как показывать событие: значок, подпись и цвет (в CSS .act-ico--<kind>); новости идут карточкой с текстом
const KIND: Record<string, { label: string; Icon: () => JSX.Element }> = {
    idea: { label: 'Идеи', Icon: IcoBulb },
    material: { label: 'Материалы', Icon: IcoFolder },
    homework: { label: 'ДЗ', Icon: IcoNote },
    schedule: { label: 'Расписание', Icon: IcoCalendar },
    user: { label: 'Участники', Icon: IcoUsers },
};
// «название» из текста события — жирным
const Text = ({ text }: { text: string }) => <>{text.split(/(«[^»]*»)/).map((t, i) => t.startsWith('«') ? <b key={i}>{t}</b> : t)}</>;
const NEWS = { news_global: 'Глобальные новости', news_group: 'Новости группы' } as Record<string, string>;

// Общая лента: всё, что происходит в группе, — новости, идеи, материалы, ДЗ, расписание, участники. Новые записи сверху.
export default function Activity({ showMsg }: { showMsg: (t: string) => void }) {
    const [items, setItems] = useState<Item[]>(() => cached<Page>('/activity')?.items ?? []);
    const [hasMore, setHasMore] = useState(() => cached<Page>('/activity')?.hasMore ?? false);
    const [loaded, setLoaded] = useState(() => !!cached('/activity'));

    const load = useCallback(async () => {
        try { const d = await api<Page>('GET', '/activity'); setItems(d.items); setHasMore(d.hasMore); }
        catch (e) { showMsg(errText(e)); } finally { setLoaded(true); }
    }, [showMsg]);
    useEffect(() => { load(); }, [load]);

    const more = async () => {
        try {
            const d = await api<Page>('GET', `/activity?before=${items[items.length - 1].id}`);
            setItems(l => [...l, ...d.items.filter(n => !l.some(o => o.id === n.id))]); setHasMore(d.hasMore);
        } catch (e) { showMsg(errText(e)); }
    };

    return (
        <>
            {loaded && items.length === 0 && <p className="empty">Пока ничего не происходило</p>}
            {items.map(a => {
                const k = KIND[a.kind];
                if (!k) return (
                    <article key={a.id} className="card">
                        <div className="row">
                            <Avatar name={clip(a.actor_name || '?')} photo={a.actor_photo} />
                            <div className="grow"><div className="nm" style={{ fontWeight: 500 }} title={a.actor_name}>{clip(a.actor_name) || 'Участник'}</div><div className="hint">{fmt(a.created_at)}</div></div>
                            <span className="chip chip--primary">{NEWS[a.kind]}</span>
                        </div>
                        <div className="post-body"><Linkify text={a.text} /></div>
                    </article>
                );
                return (
                    <article key={a.id} className="card act">
                        <span className={`act-ico act-ico--${a.kind}`}><k.Icon /></span>
                        <div className="grow">
                            <div className="act-text"><b title={a.actor_name}>{clip(a.actor_name) || 'Участник'}</b> <Text text={a.text} /></div>
                            <div className="hint">{fmt(a.created_at)}</div>
                        </div>
                        <span className={`act-tag act-ico--${a.kind}`}>{k.label}</span>
                    </article>
                );
            })}
            {hasMore && <button className="btn btn--ghost btn--full" onClick={more}>Показать ещё</button>}
        </>
    );
}
