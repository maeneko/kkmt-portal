import type { InputHTMLAttributes } from 'react';

// Чекбокс MD3: квадрат 18 dp со скруглением 2 dp, область нажатия 40 dp с кругом состояния; настоящий checkbox под ним — клавиатура и фокус работают сами.
export default function Checkbox(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
    return (
        <span className="cb">
            <input type="checkbox" {...props} />
            <span className="cb-box" aria-hidden>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="4.5 12.5 10 18 19.5 6.5" /></svg>
            </span>
        </span>
    );
}
