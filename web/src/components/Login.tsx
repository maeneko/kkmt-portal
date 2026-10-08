import { useEffect, useState } from 'react';
import { api, ApiError, clip, errText } from '../lib/api';
import TelegramLogin, { type TgSession } from './TelegramLogin';
import Logo from './Logo';
import Avatar from './Avatar';
import CodeInput from './CodeInput';

interface Config { clientId: string; groupName: string; devLogin: boolean }

export default function Login({ onDone, onConfig }: { onDone: () => void; onConfig: (c: Config) => void }) {
    const [cfg, setCfg] = useState<Config | null>(null);
    const [tg, setTg] = useState<TgSession | null>(null);
    const [devId, setDevId] = useState('1');
    const [devNick, setDevNick] = useState('');
    const [needInvite, setNeedInvite] = useState(false);
    const [invite, setInvite] = useState('');
    // после верного ключа новый участник обязательно вводит «Фамилия Имя»
    const [needName, setNeedName] = useState(false);
    const [realName, setRealName] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => { api<Config>('GET', '/config').then(c => { setCfg(c); onConfig(c); }).catch(e => setError(errText(e))); }, [onConfig]);

    const submit = async (path: string, body: Record<string, unknown>) => {
        setBusy(true); setError('');
        try {
            await api('POST', path, body);
            onDone();
        } catch (e) {
            if (e instanceof ApiError && e.data.needName) {
                setNeedName(true);
                if (realName.trim()) setError(e.message);
            } else if (e instanceof ApiError && e.data.needInvite) {
                setNeedInvite(true);
                setNeedName(false);
                if (invite) setError(e.message);
            } else setError(errText(e));
        } finally { setBusy(false); }
    };

    const withInvite = { ...(invite.trim() ? { invite: invite.trim().toUpperCase() } : {}), ...(realName.trim() ? { realName: realName.trim() } : {}) };
    const sendTg = (u: TgSession) => { setTg(u); submit('/auth/telegram', { idToken: u.idToken, ...withInvite }); };
    const sendDev = () => submit('/auth/dev', { tgId: Number(devId), username: devNick, ...withInvite });
    // Ключ отправляется сам, как только введён шестой символ (код передаём явно: state ещё не обновился)
    const sendCode = (code: string) => {
        const body = { invite: code.toUpperCase() };
        if (tg) submit('/auth/telegram', { idToken: tg.idToken, ...body });
        else submit('/auth/dev', { tgId: Number(devId), username: devNick, ...body });
    };
    const valid = /^[0-9A-Za-z]{6}$/.test(invite.trim());
    const nameOk = realName.trim().split(/\s+/).length >= 2;
    const back = () => { setNeedInvite(false); setNeedName(false); setInvite(''); setRealName(''); setTg(null); setError(''); };
    // Кто регистрируется: данные из виджета Telegram (или dev-ID без виджета)
    const who = tg
        ? { id: tg.id, name: clip(tg.name || tg.nick || `ID ${tg.id}`), nick: tg.nick, photo: tg.photo }
        : { id: devId, name: clip(devNick.replace(/^@/, '') || `Dev ${devId}`), nick: devNick.replace(/^@/, ''), photo: null };

    return (
        <div className="login-screen">
            <div className="login-card">
                <Logo size={52} />
                <h1 className="login-title">{needInvite ? 'Первый вход' : 'Приветствую вас!'}</h1>
                {needName ? (
                    <>
                        <p className="login-sub">Ключ принят. Введите фамилию и имя — их видят только староста и модераторы:</p>
                        <input className="field" autoFocus maxLength={64} autoComplete="name" placeholder="Иванов Иван" aria-label="Фамилия и имя"
                               value={realName} onChange={e => { setRealName(e.target.value); setError(''); }}
                               onKeyDown={e => e.key === 'Enter' && nameOk && !busy && (tg ? sendTg(tg) : sendDev())} />
                        <button className="btn btn--primary btn--full" disabled={busy || !nameOk} onClick={() => (tg ? sendTg(tg) : sendDev())}>Готово</button>
                        <button className="btn btn--outline btn--full" onClick={back}>Назад</button>
                    </>
                ) : needInvite ? (
                    <>
                        <div className="login-who">
                            <Avatar name={who.name} photo={who.photo} />
                            <div className="login-who-text">
                                <span className="login-who-name">{who.name}</span>
                                <span className="hint">{who.nick ? `@${who.nick}` : `ID ${who.id}`}</span>
                            </div>
                        </div>
                        <p className="login-sub">Вы новый участник. Введите инвайт-ключ от старосты (6 символов):</p>
                        <div className="code-row">
                            <CodeInput value={invite} disabled={busy} error={!!error}
                                       onChange={v => { setInvite(v); setError(''); if (/^[0-9A-Za-z]{6}$/.test(v) && !busy) sendCode(v); }}
                                       onEnter={() => valid && (tg ? sendTg(tg) : sendDev())} />
                        </div>
                        <button className="btn btn--outline btn--full" onClick={back}>Назад</button>
                    </>
                ) : (
                    <>
                        <p className="login-sub">{cfg?.groupName ? `Портал группы ${cfg.groupName}. ` : ''}Войдите через Telegram:</p>
                        {cfg?.clientId && <TelegramLogin clientId={cfg.clientId} onAuth={sendTg} />}
                        {cfg && !cfg.clientId && !cfg.devLogin && <p className="login-error">Вход через Telegram не настроен: задайте TELEGRAM_CLIENT_ID в .env</p>}
                        {cfg?.devLogin && (
                            <>
                                <p className="hint">Тестовый вход (без виджета Telegram): данные, которые иначе пришли бы из виджета</p>
                                <input className="field" inputMode="numeric" placeholder="Telegram ID" value={devId} onChange={e => setDevId(e.target.value.replace(/\D/g, ''))} aria-label="Telegram ID" />
                                <input className="field" placeholder="Ник (необязательно)" value={devNick} onChange={e => setDevNick(e.target.value)} aria-label="Ник Telegram"
                                       onKeyDown={e => e.key === 'Enter' && devId && sendDev()} />
                                <button className="btn btn--primary btn--full" disabled={busy || !devId} onClick={sendDev}>Далее</button>
                            </>
                        )}
                    </>
                )}
                {error && <p className="login-error">{error}</p>}
            </div>
        </div>
    );
}
