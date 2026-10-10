import type { TabDef } from '../tabs';

// Навигация на ПК (MD3): колонка разделов слева под шапкой. Развёрнута — «иконка + подпись» в строку;
// свёрнута (rail) — иконка и подпись под ней; переключает кнопка «три полоски» в шапке. На телефоне её нет — там нижняя навигация.
export default function NavDrawer({ tabs, active, onNavigate }: { tabs: TabDef[]; active: string; onNavigate: (id: string) => void }) {
    return (
        <nav className="nav-drawer" aria-label="Разделы">
            {tabs.map(t => (
                <button key={t.id} className="nd-item" aria-current={t.id === active ? 'page' : undefined} title={t.label} onClick={() => onNavigate(t.id)}>
                    <span className="nd-icon"><t.Icon /></span><span className="nd-label">{t.label}</span>
                </button>
            ))}
        </nav>
    );
}
