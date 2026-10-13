import { useEffect, useState } from 'react';
import { api, ApiError, clip, errText } from '../lib/api';
import TelegramLogin, { type TgSession } from './TelegramLogin';
import { IcoVK } from './icons';
import Logo from './Logo';
import Avatar from './Avatar';
import CodeInput from './CodeInput';
import RosterPicker, { type RosterName } from './RosterPicker';

interface Config { clientId: string; groupName: string; devLogin: boolean; vkClientId: string }
// Вход через VK: пропуск, подписанный сервером, и данные для показа на шаге ключа
interface VkSession { token: string; name: string; photo: string | null }

export default function Login({ onDone, onConfig }: { onDone: () => void; onConfig: (c: Config) => void }) {
    const [cfg, setCfg] = useState<Config | null>(null);
    const [tg, setTg] = useState<TgSession | null>(null);
    const [vk, setVk] = useState<VkSession | null>(null);
    const [devId, setDevId] = useState('1');
    const [devNick, setDevNick] = useState('');
    const [needInvite, setNeedInvite] = useState(false);
    const [invite, setInvite] = useState('');
    // после верного ключа новый участник обязательно выбирает своё имя в списке группы (вручную имя не вводится)
    const [needName, setNeedName] = useState(false);
    const [names, setNames] = useState<RosterName[]>([]);
    const [rosterId, setRosterId] = useState(0);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => { api<Config>('GET', '/config').then(c => { setCfg(c); onConfig(c); }).catch(e => setError(errText(e))); }, [onConfig]);

    // Возврат с id.vk.com: сервер кладёт результат во фрагмент (#vk=пропуск&name=…&photo=…)
    useEffect(() => {
        const h = new URLSearchParams(location.hash.slice(1));
        if (!h.has('vk') && !h.has('vk_error')) return;
        history.replaceState(null, '', location.pathname);
        const token = h.get('vk');
        if (!token || token === 'linked') { setError('Не удалось войти через VK. Попробуйте ещё раз'); return; }
        const s = { token, name: h.get('name') ?? '', photo: h.get('photo') || null };
        setVk(s);
        submit('/auth/vk', { vkToken: token });
    }, []);

    const submit = async (path: string, body: Record<string, unknown>) => {
        setBusy(true); setError('');
        try {
            await api('POST', path, body);
            onDone();
        } catch (e) {
            if (e instanceof ApiError && e.data.needName) {
                const free = (e.data.names as RosterName[] | undefined) ?? [];
                setNeedName(true);
                setNames(free);
                // выбранное имя могли занять, пока человек думал
                setRosterId(id => (free.some(n => n.id === id) ? id : 0));
                if (rosterId) setError(e.message);
            } else if (e instanceof ApiError && e.data.needInvite) {
                setNeedInvite(true);
                setNeedName(false);
                if (invite) setError(e.message);
            } else setError(errText(e));
        } finally { setBusy(false); }
    };

    const withInvite = { ...(invite.trim() ? { invite: invite.trim().toUpperCase() } : {}), ...(rosterId ? { rosterId } : {}) };
    const sendTg = (u: TgSession) => { setTg(u); submit('/auth/telegram', { idToken: u.idToken, ...withInvite }); };
    const sendDev = () => submit('/auth/dev', { tgId: Number(devId), username: devNick, ...withInvite });
    const sendVk = (extra: Record<string, unknown> = withInvite) => submit('/auth/vk', { vkToken: vk?.token, ...extra });
    // повторная отправка тем способом входа, каким пришёл человек
    const resend = () => (tg ? sendTg(tg) : vk ? sendVk() : sendDev());
    // Ключ отправляется сам, как только введён шестой символ (код передаём явно: state ещё не обновился)
    const sendCode = (code: string) => {
        const body = { invite: code.toUpperCase() };
        if (tg) submit('/auth/telegram', { idToken: tg.idToken, ...body });
        else if (vk) sendVk(body);
        else submit('/auth/dev', { tgId: Number(devId), username: devNick, ...body });
    };
    const valid = /^[0-9A-Za-z]{6}$/.test(invite.trim());
    const nameOk = rosterId > 0;
    const back = () => { setNeedInvite(false); setNeedName(false); setNames([]); setRosterId(0); setInvite(''); setTg(null); setVk(null); setError(''); };
    // Кто регистрируется: данные из виджета Telegram (или dev-ID без виджета)
    const who = vk
        ? { id: 'VK', name: clip(vk.name || 'VK'), nick: '', photo: vk.photo }
        : tg
        ? { id: tg.id, name: clip(tg.name || tg.nick || `ID ${tg.id}`), nick: tg.nick, photo: tg.photo }
        : { id: devId, name: clip(devNick.replace(/^@/, '') || `Dev ${devId}`), nick: devNick.replace(/^@/, ''), photo: null };

    return (
        <div className="login-screen">
            <div className="login-card">
                <Logo size={52} />
                <h1 className="login-title">{needInvite ? 'Первый вход' : 'Приветствую вас!'}</h1>
                {needName ? (
                    <>
                        <p className="login-sub">Ключ принят. Найдите себя в списке группы, имя потом не поменять:</p>
                        <RosterPicker names={names} value={rosterId} onChange={id => { setRosterId(id); setError(''); }} />
                        <button className="btn btn--primary btn--full" disabled={busy || !nameOk} onClick={resend}>Готово</button>
                        <button className="btn btn--outline btn--full" onClick={back}>Назад</button>
                    </>
                ) : needInvite ? (
                    <>
                        <div className="login-who">
                            <Avatar name={who.name} photo={who.photo} />
                            <div className="login-who-text">
                                <span className="login-who-name">{who.name}</span>
                                <span className="hint">{who.nick ? `@${who.nick}` : vk ? 'VK ID' : `ID ${who.id}`}</span>
                            </div>
                        </div>
                        <p className="login-sub">Вы новый участник. Введите инвайт-ключ от старосты (6 символов):</p>
                        <div className="code-row">
                            <CodeInput value={invite} disabled={busy} error={!!error}
                                       onChange={v => { setInvite(v); setError(''); if (/^[0-9A-Za-z]{6}$/.test(v) && !busy) sendCode(v); }}
                                       onEnter={() => valid && resend()} />
                        </div>
                        <button className="btn btn--outline btn--full" onClick={back}>Назад</button>
                    </>
                ) : (
                    <>
                        <p className="login-sub">{cfg?.groupName ? `Портал группы ${cfg.groupName}. ` : ''}Войдите через {cfg?.vkClientId ? 'Telegram или VK' : 'Telegram'}:</p>
                        {cfg?.clientId && <TelegramLogin clientId={cfg.clientId} onAuth={sendTg} />}
                        {cfg?.vkClientId && (
                            <button className="btn btn--outline btn--full" onClick={() => { location.href = '/api/auth/vk'; }}><IcoVK /> Войти через VK ID</button>
                        )}
                        {cfg && !cfg.clientId && !cfg.vkClientId && !cfg.devLogin && <p className="login-error">Вход не настроен: задайте TELEGRAM_CLIENT_ID или VK_CLIENT_ID в .env</p>}
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
