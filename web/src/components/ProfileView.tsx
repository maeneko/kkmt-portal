import { useEffect, useState, type ReactNode } from 'react';
import { ROLE_LABEL, api, cached, displayName, errText, isModerator, NICK_MAX, type PageProps, type Role } from '../lib/api';
import Avatar from './Avatar';
import { useConfirm } from './Dialog';
import RosterPicker, { type RosterName } from './RosterPicker';
import { IcoEdit, IcoTelegram, IcoVK } from './icons';
import './ProfileView.css';

interface Member { id: number; username: string | null; photo_url: string | null; display_name: string | null; real_name?: string | null; first_name: string; last_name: string | null; bio: string; role: Role }

// Весь профиль: карточка, редактирование имени, одногруппники. Живёт в шторке профиля (ProfileMenu)
// Привязанная соцсеть: капсула с иконкой и профилем (ссылкой, если он известен) и кнопка действия справа
function Social({ icon, name, handle, href, action }: { icon: ReactNode; name: string; handle?: string; href?: string; action: ReactNode }) {
    const text = <>{icon}<span>{name} · {handle ?? 'не привязан'}</span></>;
    return (
        <div className="row" style={{ gap: 8 }}>
            {href ? <a className="hw-contact-row grow" href={href} target="_blank" rel="noopener noreferrer">{text}</a> : <div className="hw-contact-row grow">{text}</div>}
            {action}
        </div>
    );
}

export default function ProfileView({ me, reloadMe, showMsg }: Pick<PageProps, 'me' | 'reloadMe' | 'showMsg'>) {
    const [name, setName] = useState(me.display_name ?? '');
    const [saving, setSaving] = useState(false);
    // «Фамилию и имя» выбирают из списка группы при регистрации; другое имя из списка назначает только староста и выше (карандаш в списке одногруппников)
    const mod = isModerator(me);
    const [pickFor, setPickFor] = useState<Member | null>(null);
    const [free, setFree] = useState<RosterName[] | null>(null);
    const [pickId, setPickId] = useState(0);
    // форма редактирования раскрывается по кнопке «Редактировать» в карточке профиля
    const [editing, setEditing] = useState(false);
    const [members, setMembers] = useState<Member[]>(() => cached<Member[]>('/users') ?? []);

    useEffect(() => { api<Member[]>('GET', '/users').then(setMembers).catch(e => showMsg(errText(e))); }, [showMsg]);

    const save = async () => {
        setSaving(true);
        try { await api('PATCH', '/me', { display_name: name }); await reloadMe(); setEditing(false); showMsg('Профиль сохранён'); }
        catch (e) { showMsg(errText(e)); } finally { setSaving(false); }
    };
    const [ask, dialog] = useConfirm();
    const unlink = async (kind: 'tg' | 'vk', title: string) => {
        if (!await ask({ title: `Отвязать ${title}?`, body: 'Входить через него больше не получится.', confirm: 'Отвязать', danger: true })) return;
        try { await api('DELETE', `/me/social/${kind}`); await reloadMe(); showMsg(`${title} отвязан`); } catch (e) { showMsg(errText(e)); }
    };
    const openPick = (m: Member) => {
        setPickFor(m); setPickId(0); setFree(null);
        api<RosterName[]>('GET', '/roster/free').then(setFree).catch(e => { showMsg(errText(e)); setPickFor(null); });
    };
    const assign = async () => {
        if (!pickFor) return;
        try {
            await api('PUT', `/users/${pickFor.id}/roster`, { id: pickId });
            setPickFor(null); setMembers(await api<Member[]>('GET', '/users')); await reloadMe(); showMsg('Имя изменено');
        } catch (e) { showMsg(errText(e)); openPick(pickFor); } // имя могли занять раньше
    };
    const shown = displayName(me);
    const dirty = name !== (me.display_name ?? '');
    const cancel = () => { setName(me.display_name ?? ''); setEditing(false); };

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
                    <div className="stack" style={{ gap: 4 }}><span className="label">Фамилия и имя</span>
                        <span>{me.real_name || '—'}</span>
                        <span className="hint">Выбрано из списка группы, другое назначает староста или админ</span>
                    </div>
                    <div className="stack" style={{ gap: 10, margin: '8px 0' }}>
                        <span className="label">Привязанные соцсети</span>
                        <Social icon={<IcoTelegram />} name="Telegram" handle={me.tg_linked ? (me.username ? `@${me.username}` : 'привязан') : undefined}
                                href={me.tg_linked && me.username ? `https://t.me/${me.username}` : undefined}
                                action={me.tg_linked && <button type="button" className="btn btn--outline btn--sm" disabled={!me.vk_id} title={me.vk_id ? undefined : 'Единственный способ входа'} onClick={() => unlink('tg', 'Telegram')}>Отвязать</button>} />
                        <Social icon={<IcoVK />} name="VK" handle={me.vk_id ? `id${me.vk_id}` : undefined} href={me.vk_id ? `https://vk.com/id${me.vk_id}` : undefined}
                                action={me.vk_id
                                    ? <button type="button" className="btn btn--outline btn--sm" disabled={!me.tg_linked} title={me.tg_linked ? undefined : 'Единственный способ входа'} onClick={() => unlink('vk', 'VK')}>Отвязать</button>
                                    : <button type="button" className="btn btn--tonal btn--sm" onClick={() => { location.href = '/api/auth/vk'; }}>Привязать</button>} />
                    </div>
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
                            {mod && <button className="btn-icon btn-icon--neutral" aria-label="Выбрать другое имя из списка" onClick={() => openPick(m)}><IcoEdit /></button>}
                            {m.role !== 'student' && <span className="chip chip--primary">{ROLE_LABEL[m.role]}</span>}
                        </div>
                    ))}
                </div>
            </div>
            {dialog}
            {pickFor && (
                <div className="scrim-dialog" onMouseDown={e => { if (e.target === e.currentTarget) setPickFor(null); }}>
                    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="pick-title">
                        <h2 className="dialog-title" id="pick-title">Имя для {displayName(pickFor)}</h2>
                        <div className="dialog-body">
                            {free === null ? <p className="hint">Загрузка…</p> : free.length === 0 ? <p>Свободных имён в списке группы нет.</p> : (
                                <>
                                    {pickFor.real_name && <p>Сейчас: {pickFor.real_name}. Оно освободится и станет доступно другим.</p>}
                                    <RosterPicker names={free} value={pickId} onChange={setPickId} />
                                </>
                            )}
                        </div>
                        <div className="dialog-actions">
                            <button className="btn btn--tonal" onClick={() => setPickFor(null)}>Отмена</button>
                            <button className="btn btn--primary" disabled={!pickId} onClick={assign}>Назначить</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
