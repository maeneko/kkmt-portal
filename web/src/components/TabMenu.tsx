import { useEffect, useRef, useState } from 'react';
import type { TabDef } from '../tabs';
import { IcoChevron, IcoLogout } from './icons';

// Выпадающий список вкладок в правом верхнем углу: текущая вкладка + шеврон, меню с остальными и «Выйти».
// onOpen вызывается при раскрытии меню (App закрывает подробности пары, чтобы они не перекрывали список).
export default function TabMenu({ tabs, active, onNavigate, onLogout, onOpen }: {
    tabs: TabDef[]; active: TabDef; onNavigate: (id: string) => void; onLogout: () => void; onOpen: () => void;
}) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', down);
        document.addEventListener('keydown', key);
        return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
    }, [open]);

    return (
        <div className="tab-menu" ref={root}>
            <button className="tab-menu-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => { if (!open) onOpen(); setOpen(o => !o); }}>
                <active.Icon /> <span>{active.label}</span>
                <span className={`tab-menu-chev${open ? ' tab-menu-chev--open' : ''}`}><IcoChevron /></span>
            </button>
            {open && (
                <div className="tab-menu-list" role="menu">
                    {tabs.map(t => (
                        <button key={t.id} role="menuitem" className={`tab-menu-item${t.id === active.id ? ' tab-menu-item--active' : ''}`}
                                onClick={() => { onNavigate(t.id); setOpen(false); }}>
                            <t.Icon /> {t.label}
                        </button>
                    ))}
                    <hr className="tab-menu-sep" />
                    <button role="menuitem" className="tab-menu-item tab-menu-item--danger" onClick={() => { setOpen(false); onLogout(); }}>
                        <IcoLogout /> Выйти
                    </button>
                </div>
            )}
        </div>
    );
}
