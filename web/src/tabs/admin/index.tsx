import { useCallback, useEffect, useState } from 'react';
import { api, clip, displayName, errText, type PageProps, type Role } from '../../lib/api';
import Avatar from '../../components/Avatar';
import { useConfirm } from '../../components/Dialog';
import { IcoCopy, IcoPlus, IcoTrash } from '../../components/icons';
import './admin.css';

interface Invite { code: string; created_at: string; max_uses: number; used_count: number; used_by: string[] }
interface Member { id: number; username: string | null; first_name: string; last_name: string | null; display_name: string | null; photo_url: string | null; role: Role }

function Invites({ showMsg }: Pick<PageProps, 'showMsg'>) {
    const [list, setList] = useState<Invite[]>([]);
    const [uses, setUses] = useState('1');
    const load = useCallback(() => api<Invite[]>('GET', '/admin/invites').then(setList).catch(e => showMsg(errText(e))), [showMsg]);
    useEffect(() => { load(); }, [load]);

    const n = Number(uses);
    const usesOk = Number.isInteger(n) && n >= 1 && n <= 1000;

    const create = async () => {
        try { const { code } = await api<{ code: string }>('POST', '/admin/invites', { max_uses: n }); await load(); showMsg(`Ключ ${code} создан`); } catch (e) { showMsg(errText(e)); }
    };
    const copy = async (code: string) => {
        try { await navigator.clipboard.writeText(code); showMsg('Скопировано'); } catch { showMsg(code); }
    };
    const remove = async (code: string) => {
        try { await api('DELETE', `/admin/invites/${code}`); await load(); } catch (e) { showMsg(errText(e)); }
    };

    return (
        <section className="card">
            <span className="card-title">Инвайт-ключи</span>
            <div className="invite-new">
                <label className="invite-uses">
                    <span className="hint">Сколько раз можно использовать</span>
                    <input className="field" type="number" min={1} max={1000} inputMode="numeric" value={uses} onChange={e => setUses(e.target.value)} />
                </label>
                <button className="btn btn--primary" disabled={!usesOk} onClick={create}><IcoPlus /> Создать ключ</button>
            </div>
            <p className="hint">По ключу регистрируется столько человек, сколько указано. Когда лимит исчерпан, ключ перестаёт работать.</p>
            {list.length === 0 && <p className="muted">Ключей пока нет</p>}
            {list.map(i => {
                const left = i.max_uses - i.used_count;
                return (
                    <div className="invite-row" key={i.code}>
                        <div className="grow">
                            <span className="invite-code">{i.code}</span>
                            {i.used_by.length > 0 && <div className="hint">{i.used_by.map(n => clip(n)).join(', ')}</div>}
                        </div>
                        {left > 0
                            ? <span className="chip chip--online"><span className="chip-dot" /> Осталось {left} из {i.max_uses}</span>
                            : <span className="chip">Использован {i.used_count}/{i.max_uses}</span>}
                        {left > 0 && <button className="btn-icon" aria-label="Копировать" onClick={() => copy(i.code)}><IcoCopy /></button>}
                        <button className="btn-icon btn-icon--danger" aria-label="Удалить ключ" onClick={() => remove(i.code)}><IcoTrash /></button>
                    </div>
                );
            })}
        </section>
    );
}

function Members({ me, showMsg }: Pick<PageProps, 'me' | 'showMsg'>) {
    const [ask, dialog] = useConfirm();
    const [list, setList] = useState<Member[]>([]);
    const load = useCallback(() => api<Member[]>('GET', '/admin/users').then(setList).catch(e => showMsg(errText(e))), [showMsg]);
    useEffect(() => { load(); }, [load]);

    const setRole = async (m: Member, role: Role) => {
        try { await api('PATCH', `/admin/users/${m.id}`, { role }); await load(); } catch (e) { showMsg(errText(e)); }
    };
    const remove = async (m: Member) => {
        if (!await ask({ title: `Удалить «${displayName(m)}»?`, body: 'Участник потеряет доступ, его посты и комментарии тоже удалятся.', confirm: 'Удалить', danger: true })) return;
        try { await api('DELETE', `/admin/users/${m.id}`); await load(); } catch (e) { showMsg(errText(e)); }
    };

    return (
        <section className="card">
            <span className="card-title">Участники · {list.length}</span>
            {list.map(m => (
                <div className="member-row" key={m.id}>
                    <Avatar name={displayName(m)} photo={m.photo_url} />
                    <div className="grow"><div className="nm" style={{ fontWeight: 500 }}>{displayName(m)}</div>{m.username && <div className="hint nm">@{m.username}</div>}</div>
                    {m.role === 'owner' ? <span className="chip chip--primary">Главный админ</span> : (
                        <>
                            {me.role === 'owner'
                                ? (
                                    <select className="field role-select" aria-label={`Роль: ${displayName(m)}`} value={m.role}
                                            onChange={e => setRole(m, e.target.value as Role)}>
                                        <option value="student">Студент</option>
                                        <option value="admin">Админ</option>
                                    </select>
                                )
                                : <span className={`chip ${m.role === 'admin' ? 'chip--primary' : ''}`}>{m.role === 'admin' ? 'Админ' : 'Студент'}</span>}
                            {(m.role === 'student' || me.role === 'owner') && <button className="btn-icon btn-icon--danger" aria-label="Удалить участника" onClick={() => remove(m)}><IcoTrash /></button>}
                        </>
                    )}
                </div>
            ))}
            {dialog}
        </section>
    );
}

export default function Admin({ me, showMsg }: PageProps) {
    const [section, setSection] = useState<'invites' | 'members'>('invites');
    const SECTIONS = [['invites', 'Ключи'], ['members', 'Участники']] as const;
    return (
        <>
            <div className="seg seg--full" role="tablist">
                {SECTIONS.map(([id, label]) => (
                    <button key={id} role="tab" aria-selected={section === id} onClick={() => setSection(id)}>{label}</button>
                ))}
            </div>
            {section === 'invites' && <Invites showMsg={showMsg} />}
            {section === 'members' && <Members me={me} showMsg={showMsg} />}
        </>
    );
}
