import { useCallback, useEffect, useState } from 'react';
import { api, errText } from '../lib/api';
import RosterPicker, { type RosterName } from './RosterPicker';

// Непропускаемое окно: пока человек не выбрал своё имя в списке группы, приложением пользоваться нельзя (закрыть окно нельзя).
export default function RosterGate({ reloadMe, onLogout }: { reloadMe: () => Promise<void>; onLogout: () => void }) {
    const [names, setNames] = useState<RosterName[] | null>(null);
    const [id, setId] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(''); // snackbar лежит ниже затемнения окна, поэтому ошибку показываем внутри
    const load = useCallback(() => api<RosterName[]>('GET', '/roster/free').then(setNames).catch(e => setError(errText(e))), []);
    useEffect(() => { load(); }, [load]);

    const send = async () => {
        setBusy(true); setError('');
        try { await api('POST', '/me/roster', { id }); await reloadMe(); }
        catch (e) { setError(errText(e)); setId(0); await load(); } // имя могли занять раньше
        finally { setBusy(false); }
    };

    return (
        <div className="scrim-dialog">
            <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="rg-title">
                <h2 className="dialog-title" id="rg-title">Выберите себя в списке</h2>
                <div className="dialog-body">
                    {names === null ? <p className="hint">Загрузка…</p> : names.length === 0
                        ? <p>В списке группы не осталось свободных имён. Обратитесь к старосте или админу.</p>
                        : (
                            <>
                                <p>Староста ведёт список группы. Найдите своё имя: оно закрепится за вами, потом его сможет изменить только староста или админ.</p>
                                <RosterPicker names={names} value={id} onChange={setId} />
                            </>
                        )}
                    {error && <p className="login-error">{error}</p>}
                </div>
                <div className="dialog-actions">
                    <button className="btn btn--tonal" onClick={onLogout}>Выйти</button>
                    <button className="btn btn--primary" disabled={busy || !id} onClick={send}>Подтвердить</button>
                </div>
            </div>
        </div>
    );
}
