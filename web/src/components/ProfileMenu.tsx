import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { clip, displayName, type Me, type PageProps } from '../lib/api';
import type { TabDef } from '../tabs';
import Avatar from './Avatar';
import ProfileView from './ProfileView';
import { IcoLogout, IcoMoon, IcoShield, IcoSun } from './icons';

// Капсула профиля в правом верхнем углу: аватарка и имя; по нажатию справа выезжает шторка.
// Сверху — маленькие кнопки (тема, режим админа у модераторов и выше, «Админка»), ниже — весь профиль и «Выйти».
export default function ProfileMenu({ me, tabs, active, onNavigate, dark, onDark, adminMode, onAdminMode, onLogout, onOpen, reloadMe, showMsg }: {
    me: Me; tabs: TabDef[]; active: string; onNavigate: (id: string) => void;
    dark: boolean; onDark: () => void; adminMode?: boolean; onAdminMode?: () => void; onLogout: () => void; onOpen: () => void;
} & Pick<PageProps, 'reloadMe' | 'showMsg'>) {
    const [open, setOpen] = useState(false);
    // профиль (и список одногруппников) грузится при первом открытии, а не при старте
    const [seen, setSeen] = useState(false);
    const name = clip(displayName(me));
    const tab = open ? 0 : -1;

    useEffect(() => {
        if (!open) return;
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('keydown', key);
        return () => document.removeEventListener('keydown', key);
    }, [open]);

    return (
        <>
            <button className="profile-capsule" aria-haspopup="dialog" aria-expanded={open} onClick={() => { onOpen(); setSeen(true); setOpen(true); }}>
                <span className="profile-capsule-name">{name}</span>
                <Avatar name={name} photo={me.photo_url} />
            </button>
            {/* в body: внутри шапки шторка оказалась бы под нижней навигацией (у шапки свой слой) */}
            {createPortal(<>
            <div className={`pm-scrim${open ? ' pm-scrim--open' : ''}`} onClick={() => setOpen(false)} />
            <aside className={`pm${open ? ' pm--open' : ''}`} role="dialog" aria-label="Профиль" aria-hidden={!open}>
                <div className="pm-head">
                    <span className="pm-title">Профиль</span>
                    <button className="theme-toggle theme-toggle--inline" tabIndex={tab} title={dark ? 'Светлая тема' : 'Тёмная тема'} aria-label={dark ? 'Светлая тема' : 'Тёмная тема'} onClick={onDark}>
                        {dark ? <IcoSun /> : <IcoMoon />}
                    </button>
                    {onAdminMode && (
                        <button className="theme-toggle theme-toggle--inline" tabIndex={tab} aria-pressed={adminMode} title={adminMode ? 'Режим админа включён: видны кнопки правки' : 'Режим админа выключен: интерфейс как у студента'}
                                aria-label={adminMode ? 'Выключить режим админа' : 'Включить режим админа'} onClick={onAdminMode}>
                            <IcoShield />
                        </button>
                    )}
                    {tabs.map(t => (
                        <button key={t.id} className="btn btn--outline btn--sm" aria-current={t.id === active} tabIndex={tab} onClick={() => { onNavigate(t.id); setOpen(false); }}>
                            <t.Icon />{t.label}
                        </button>
                    ))}
                    <button className="btn-icon btn-icon--neutral" aria-label="Закрыть" tabIndex={tab} onClick={() => setOpen(false)}>✕</button>
                </div>
                <hr className="pm-sep" />
                <div className="pm-profile">{seen && <ProfileView me={me} reloadMe={reloadMe} showMsg={showMsg} />}</div>
                <hr className="pm-sep" />
                <button className="pm-item pm-item--danger" tabIndex={tab} onClick={() => { setOpen(false); onLogout(); }}>
                    <IcoLogout /><span className="grow">Выйти</span>
                </button>
            </aside>
            </>, document.body)}
        </>
    );
}
