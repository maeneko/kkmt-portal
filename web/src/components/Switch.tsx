import type { InputHTMLAttributes } from 'react';

// Переключатель MD3: настоящий checkbox под треком — клавиатура и фокус работают сами.
export default function Switch(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
    return (
        <span className="switch">
            <input type="checkbox" role="switch" {...props} />
            <span className="switch-track" aria-hidden />
        </span>
    );
}
