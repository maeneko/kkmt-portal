import type { TabDef } from '../tabs';

// MD3 navigation bar (как в SenAWG): иконка в индикаторе-таблетке 64×32 и подпись 12px. Только на телефоне.
export default function BottomNav({ tabs, active, onNavigate }: { tabs: TabDef[]; active: string; onNavigate: (id: string) => void }) {
    return (
        <nav className="bottom-nav" aria-label="Разделы">
            {tabs.map(t => (
                <button key={t.id} type="button" className="bn-item" aria-current={t.id === active ? 'page' : undefined} onClick={() => onNavigate(t.id)}>
                    <span className="bn-indicator"><t.Icon /></span>
                    <span className="bn-label">{t.label}</span>
                </button>
            ))}
        </nav>
    );
}
