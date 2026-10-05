import { useEffect, useState } from 'react';
import { api, displayName, errText, NICK_MAX, type PageProps, type Role } from '../../lib/api';
import Avatar from '../../components/Avatar';
import { IcoLogout } from '../../components/icons';
import './profile.css';

interface Member { id: number; username: string | null; photo_url: string | null; display_name: string | null; first_name: string; last_name: string | null; bio: string; role: Role }
const ROLE: Record<Role, string> = { owner: 'Главный админ', admin: 'Админ', student: 'Студент' };

export default function Profile({ me, reloadMe, showMsg, logout }: PageProps) {
    const [name, setName] = useState(me.display_name ?? '');
    const [saving, setSaving] = useState(false);
    const [members, setMembers] = useState<Member[]>([]);

    useEffect(() => { api<Member[]>('GET', '/users').then(setMembers).catch(e => showMsg(errText(e))); }, [showMsg]);

    const save = async () => {
        setSaving(true);
        try { await api('PATCH', '/me', { display_name: name }); await reloadMe(); showMsg('Профиль сохранён'); }
        catch (e) { showMsg(errText(e)); } finally { setSaving(false); }
    };
    const shown = displayName(me);
    const dirty = name !== (me.display_name ?? '');

    return (
        <>
            <div className="card">
                <div className="profile-head">
                    <Avatar name={shown} photo={me.photo_url} large />
                    <div className="grow">
                        <div className="profile-name nm" title={me.display_name || undefined}>{shown}</div>
                        {me.username && <div className="muted nm">@{me.username}</div>}
                        <span className={`chip ${me.role === 'student' ? '' : 'chip--primary'}`} style={{ marginTop: 6 }}>{ROLE[me.role]}</span>
                    </div>
                </div>
                <label className="stack" style={{ gap: 6 }}><span className="label">Отображаемое имя</span>
                    <input className="field" maxLength={NICK_MAX} placeholder={[me.first_name, me.last_name].filter(Boolean).join(' ')} value={name} onChange={e => setName(e.target.value)} />
                </label>
                <button className="btn btn--primary" style={{ alignSelf: 'flex-start' }} disabled={saving || !dirty} onClick={save}>Сохранить</button>
            </div>

            <div className="card">
                <span className="card-title">Одногруппники · {members.length}</span>
                <div>
                    {members.map(m => (
                        <div className="member" key={m.id}>
                            <Avatar name={displayName(m)} photo={m.photo_url} />
                            <div className="grow">
                                <div className="nm" style={{ fontWeight: 500 }}>{displayName(m)}</div>
                                <div className="hint nm">{m.username ? `@${m.username}` : ''}</div>
                            </div>
                            {m.role !== 'student' && <span className="chip chip--primary">{ROLE[m.role]}</span>}
                        </div>
                    ))}
                </div>
            </div>
            <button className="btn btn--danger only-mobile" style={{ alignSelf: 'flex-start' }} onClick={logout}><IcoLogout /> Выйти из аккаунта</button>
        </>
    );
}
