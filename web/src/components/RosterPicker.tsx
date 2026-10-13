import { useState } from 'react';
import { IcoCheck } from './icons';
import './RosterPicker.css';

export interface RosterName { id: number; name: string }

// Выбор своего имени в списке группы: поиск и список свободных имён, выбранное подсвечено
export default function RosterPicker({ names, value, onChange }: { names: RosterName[]; value: number; onChange: (id: number) => void }) {
    const [q, setQ] = useState('');
    const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е'); // «Семенов» находит «Семёнов»
    const shown = names.filter(n => norm(n.name).includes(norm(q.trim())));
    return (
        <div className="rp">
            <input className="field" placeholder="Поиск по фамилии" aria-label="Поиск" value={q} onChange={e => setQ(e.target.value)} />
            <div className="rp-list" role="listbox" aria-label="Список группы">
                {shown.map(n => (
                    <button type="button" key={n.id} role="option" aria-selected={n.id === value} className={`rp-item${n.id === value ? ' rp-item--sel' : ''}`} onClick={() => onChange(n.id)}>
                        <span className="grow">{n.name}</span>{n.id === value && <IcoCheck />}
                    </button>
                ))}
                {shown.length === 0 && <p className="hint rp-empty">Ничего не найдено</p>}
            </div>
        </div>
    );
}
