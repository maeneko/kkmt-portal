import { useEffect, useState } from 'react';
import { IcoChevron } from '../../components/icons';

const WEEK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// MD3 date picker: месяц со стрелками, сетка дней (с понедельника); сегодня обведено, выбранная дата залита.
export default function DatePicker({ value, onPick, onClose }: { value: Date; onPick: (date: string) => void; onClose: () => void }) {
    const [month, setMonth] = useState(() => new Date(value.getFullYear(), value.getMonth(), 1));
    useEffect(() => {
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', key);
        return () => document.removeEventListener('keydown', key);
    }, [onClose]);

    const today = iso(new Date()), selected = iso(value);
    const offset = (month.getDay() + 6) % 7;
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const cells = Array.from({ length: offset + days }, (_, i) => (i < offset ? null : new Date(month.getFullYear(), month.getMonth(), i - offset + 1)));
    const title = month.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '');
    const shift = (n: number) => setMonth(m => new Date(m.getFullYear(), m.getMonth() + n, 1));

    return (
        <div className="scrim-dialog" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="dialog dp" role="dialog" aria-modal="true" aria-label="Выбор даты">
                <div className="dp-head">
                    <span className="dp-title">{title[0].toUpperCase() + title.slice(1)}</span>
                    <button className="btn-icon btn-icon--neutral dp-prev" aria-label="Предыдущий месяц" onClick={() => shift(-1)}><IcoChevron /></button>
                    <button className="btn-icon btn-icon--neutral dp-next" aria-label="Следующий месяц" onClick={() => shift(1)}><IcoChevron /></button>
                </div>
                <div className="dp-grid">
                    {WEEK.map(w => <span key={w} className="dp-wd">{w}</span>)}
                    {cells.map((d, i) => {
                        if (!d) return <span key={i} />;
                        const v = iso(d);
                        return (
                            <button key={v} className={`dp-day${v === today ? ' dp-day--today' : ''}${v === selected ? ' dp-day--sel' : ''}${d.getDay() === 0 ? ' dp-day--off' : ''}`}
                                    aria-pressed={v === selected} onClick={() => onPick(v)}>
                                {d.getDate()}
                            </button>
                        );
                    })}
                </div>
                <div className="dialog-actions">
                    <button className="btn btn--tonal" onClick={() => onPick(today)}>Сегодня</button>
                    <button className="btn btn--tonal" onClick={onClose}>Отмена</button>
                </div>
            </div>
        </div>
    );
}
