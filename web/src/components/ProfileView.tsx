import { useEffect, useState } from 'react';
import { ROLE_LABEL, api, cached, displayName, errText, NICK_MAX, type PageProps, type Role } from '../lib/api';
import Avatar from './Avatar';
import { IcoEdit } from './icons';
import './ProfileView.css';

interface Member { id: number; username: string | null; photo_url: string | null; display_name: string | null; real_name?: string | null; first_name: string; last_name: string | null; bio: string; role: Role }

// Весь профиль: карточка, редактирование имени, одногруппники. Живёт в шторке профиля (ProfileMenu)
export default function ProfileView({ me, reloadMe, showMsg }: Pick<PageProps, 'me' | 'reloadMe' | 'showMsg'>) {
    const [name, setName] = useState(me.display_name ?? '');
    const [realName, setRealName] = useState(me.real_name ?? '');
    const [saving, setSaving] = useState(false);
    // форма редактирования раскрывается по кнопке «Редактировать» в карточке профиля
    const [editing, setEditing] = useState(false);
    const [members, setMembers] = useState<Member[]>(() => cached<Member[]>('/users') ?? []);

    useEffect(() => { api<Member[]>('GET', '/users').then(setMembers).catch(e => showMsg(errText(e))); }, [showMsg]);

    const save = async () => {
        setSaving(true);
        try { await api('PATCH', '/me', { display_name: name, real_name: realName }); await reloadMe(); setEditing(false); showMsg('Профиль сохранён'); }
        catch (e) { showMsg(errText(e)); } finally { setSaving(false); }
    };
    const shown = displayName(me);
    const dirty = name !== (me.display_name ?? '') || realName !== (me.real_name ?? '');
    const cancel = () => { setName(me.display_name ?? ''); setRealName(me.real_name ?? ''); setEditing(false); };

    return (
        <>
            {/* на десктопе две карточки рядом: слева профиль, справа редактирование */}
            <div className="profile-top">
                <div className="card profile-card">
                    <div className="profile-head">
                        <Avatar name={shown} photo={me.photo_url} large />
                        <div className="grow profile-info">
                            <div className="profile-name nm" title={me.display_name || undefined}>{shown}</div>
                            {me.username && <div className="muted nm">@{me.username}</div>}
                            {me.real_name && <div className="hint nm">{me.real_name}</div>}
                            <span className={`chip ${me.role === 'student' ? '' : 'chip--primary'}`}>{ROLE_LABEL[me.role]}</span>
                        </div>
                    </div>
                    <div className={`fold profile-edit-fold${editing ? '' : ' fold--open'}`}>
                        <div className="fold-in"><button className="btn btn--tonal btn--sm profile-edit" tabIndex={editing ? -1 : 0} onClick={() => setEditing(true)}><IcoEdit /> Редактировать</button></div>
                    </div>
                </div>

                <div className={`fold${editing ? ' fold--open' : ''}`}>
                  <div className="fold-in">
                <div className="card profile-form">
                    <span className="card-title">Редактирование</span>
                    <label className="stack" style={{ gap: 6 }}><span className="label">Отображаемое имя</span>
                        <input className="field" maxLength={NICK_MAX} placeholder={[me.first_name, me.last_name].filter(Boolean).join(' ')} value={name} onChange={e => setName(e.target.value)} />
                    </label>
                    <label className="stack" style={{ gap: 6 }}><span className="label">Фамилия и имя</span>
                        <input className="field" maxLength={64} placeholder="Иванов Иван" autoComplete="name" value={realName} onChange={e => setRealName(e.target.value)} />
                        <span className="hint">Видят только модераторы и админы</span>
                    </label>
                    <div className="row" style={{ gap: 8 }}>
                        <button className="btn btn--primary" disabled={saving || !dirty} onClick={save}>Сохранить</button>
                        <button className="btn btn--tonal" disabled={saving} onClick={cancel}>Отмена</button>
                    </div>
                </div>
                  </div>
                </div>
            </div>

            <div className="card">
                <span className="card-title">Одногруппники · {members.length}</span>
                <div>
                    {members.map(m => (
                        <div className="member" key={m.id}>
                            <Avatar name={displayName(m)} photo={m.photo_url} />
                            <div className="grow">
                                <div className="nm" style={{ fontWeight: 500 }}>{displayName(m)}</div>
                                <div className="hint nm">{[m.real_name, m.username && `@${m.username}`].filter(Boolean).join(' · ')}</div>
                            </div>
                            {m.role !== 'student' && <span className="chip chip--primary">{ROLE_LABEL[m.role]}</span>}
                        </div>
                    ))}
                </div>
            </div>
        </>
    );
}
