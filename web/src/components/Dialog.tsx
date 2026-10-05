import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface Ask { title: string; body?: ReactNode; confirm: string; danger?: boolean }
type Pending = Ask & { resolve: (ok: boolean) => void };

// Модальный диалог по центру (как в SenAWG): tonal «Отмена» слева от главного/опасного действия;
// Escape и клик по scrim закрывают. Заменяет window.confirm().
export function useConfirm(): [(a: Ask) => Promise<boolean>, ReactNode] {
    const [pending, setPending] = useState<Pending | null>(null);
    const [leaving, setLeaving] = useState(false);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const lastFocus = useRef<Element | null>(null);

    const ask = useCallback((a: Ask) => new Promise<boolean>(resolve => {
        lastFocus.current = document.activeElement;
        setLeaving(false);
        setPending({ ...a, resolve });
    }), []);

    const close = useCallback((ok: boolean) => {
        if (!pending) return;
        setLeaving(true);
        window.setTimeout(() => {
            pending.resolve(ok);
            setPending(null);
            setLeaving(false);
            (lastFocus.current as HTMLElement | null)?.focus?.();
        }, 200);
    }, [pending]);

    useEffect(() => {
        if (!pending) return;
        cancelRef.current?.focus();
        const h = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
        document.addEventListener('keydown', h);
        return () => document.removeEventListener('keydown', h);
    }, [pending, close]);

    const node = pending && (
        <div className={`scrim-dialog${leaving ? ' scrim-dialog--out' : ''}`} onMouseDown={e => { if (e.target === e.currentTarget) close(false); }}>
            <div className={`dialog${leaving ? ' dialog--out' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
                <h2 className="dialog-title" id="dlg-title">{pending.title}</h2>
                {pending.body && <div className="dialog-body">{pending.body}</div>}
                <div className="dialog-actions">
                    <button ref={cancelRef} className="btn btn--tonal" onClick={() => close(false)}>Отмена</button>
                    <button className={`btn ${pending.danger ? 'btn--danger' : 'btn--primary'}`} onClick={() => close(true)}>{pending.confirm}</button>
                </div>
            </div>
        </div>
    );
    return [ask, node];
}
