import { Fragment, useState } from 'react';
import type { TabDef } from '../tabs';
import { IcoChevron } from './icons';

const SUB_KEY = 'kkmt.navSub';

// Навигация на ПК (MD3): колонка разделов слева под шапкой. Развёрнута — «иконка + подпись» в строку;
// свёрнута (rail) — иконка и подпись под ней; переключает кнопка «три полоски» в шапке. На телефоне её нет — там нижняя навигация.
// Под открытым разделом — его подпункты (каналы ленты); повторный клик по разделу их прячет и показывает.
export default function NavDrawer({ tabs, active, onNavigate }: { tabs: TabDef[]; active: string; onNavigate: (id: string) => void }) {
    const [subOpen, setSubOpen] = useState(() => { try { return localStorage.getItem(SUB_KEY) !== 'off'; } catch { return true; } });
    const toggleSub = () => {
        setSubOpen(!subOpen);
        try { localStorage.setItem(SUB_KEY, subOpen ? 'off' : 'on'); } catch { /* не критично */ }
    };
    return (
        <nav className="nav-drawer" aria-label="Разделы">
            {tabs.map(t => (
                <Fragment key={t.id}>
                    <button className="nd-item" aria-current={t.id === active ? 'page' : undefined} aria-expanded={t.id === active ? subOpen : undefined} title={t.label}
                            onClick={() => t.id === active ? toggleSub() : onNavigate(t.id)}>
                        <span className="nd-icon"><t.Icon /></span><span className="nd-label">{t.label}</span>
                        {t.id === active && <span className="nd-chev"><IcoChevron /></span>}
                    </button>
                    {/* подпункты открытого раздела ставит сама страница (каналы ленты) */}
                    {t.id === active && <div className={`nd-sub${subOpen ? '' : ' nd-sub--hidden'}`} id="nav-sub" />}
                </Fragment>
            ))}
        </nav>
    );
}
