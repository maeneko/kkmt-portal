import { useEffect, useRef } from 'react';

const LEN = 6;
const clean = (s: string) => s.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();

// Код из 6 ячеек (цифры и латинские буквы): автопереход вперёд, Backspace — назад, вставка целиком.
export default function CodeInput({ value, onChange, onEnter, disabled, error }: {
    value: string; onChange: (v: string) => void; onEnter?: () => void; disabled?: boolean; error?: boolean;
}) {
    const refs = useRef<(HTMLInputElement | null)[]>([]);
    const chars = Array.from({ length: LEN }, (_, i) => value[i] ?? '');
    const focus = (i: number) => { const el = refs.current[Math.max(0, Math.min(LEN - 1, i))]; el?.focus(); el?.select(); };

    // После проверки (поле было заблокировано) возвращаем курсор в последнюю ячейку, чтобы можно было поправить символ
    useEffect(() => { if (!disabled && value.length === LEN) focus(LEN - 1); }, [disabled]); // eslint-disable-line react-hooks/exhaustive-deps

    const set = (i: number, ch: string) => {
        const next = chars.slice();
        next[i] = ch;
        onChange(next.join('').slice(0, LEN));
    };

    return (
        <div className={`code-cells${error ? ' code-cells--error' : ''}${disabled ? ' code-cells--busy' : ''}`} role="group" aria-label="Инвайт-ключ, 6 символов">
            {chars.map((ch, i) => (
                <input
                    key={i}
                    ref={el => { refs.current[i] = el; }}
                    className="code-cell"
                    style={{ '--i': i } as React.CSSProperties}
                    value={ch}
                    inputMode="text"
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus={i === 0}
                    disabled={disabled}
                    aria-label={`Символ ${i + 1} из ${LEN}`}
                    onFocus={e => e.target.select()}
                    onChange={e => {
                        const v = clean(e.target.value);
                        if (!v) { set(i, ''); return; }
                        if (v.length > 1) {
                            // несколько символов сразу (автозаполнение, вставка в одну ячейку)
                            const merged = (value.slice(0, i) + v).slice(0, LEN);
                            onChange(merged); focus(merged.length);
                            return;
                        }
                        set(i, v); if (i < LEN - 1) focus(i + 1);
                    }}
                    onKeyDown={e => {
                        if (e.key === 'Backspace' && !ch && i > 0) { e.preventDefault(); set(i - 1, ''); focus(i - 1); }
                        else if (e.key === 'ArrowLeft') { e.preventDefault(); focus(i - 1); }
                        else if (e.key === 'ArrowRight') { e.preventDefault(); focus(i + 1); }
                        else if (e.key === 'Enter') onEnter?.();
                    }}
                    onPaste={e => {
                        e.preventDefault();
                        const v = clean(e.clipboardData.getData('text')).slice(0, LEN);
                        if (v) { onChange(v); focus(v.length); }
                    }}
                />
            ))}
        </div>
    );
}
