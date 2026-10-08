import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { IcoTelegram } from './icons';

// Результат входа: подписанный id_token (его проверяет сервер) и данные для показа на шаге ключа.
export interface TgSession { idToken: string; id: number; name: string; nick: string; photo: string | null }

interface LoginResult { id_token?: string; user?: { id?: number; name?: string; preferred_username?: string; picture?: string }; error?: string }
interface AuthOptions { client_id: number | string; scope?: string[]; nonce?: string; lang?: string }
declare global { interface Window { Telegram?: { Login?: { auth: (opts: AuthOptions, cb: (r: LoginResult) => void) => void } } } }

const SRC = 'https://oauth.telegram.org/js/telegram-login.js?6';

// «Log In With Telegram» (OpenID Connect): библиотека Telegram открывает окно входа и возвращает id_token.
// Старый виджет (bot_id, data-onauth) Telegram закрыл. nonce берём заранее, чтобы окно открывалось синхронно по клику
// (иначе браузер заблокирует всплывающее окно).
export default function TelegramLogin({ clientId, onAuth }: { clientId: string; onAuth: (s: TgSession) => void }) {
    const [ready, setReady] = useState(() => !!window.Telegram?.Login);
    const [nonce, setNonce] = useState('');
    const [error, setError] = useState('');

    const loadNonce = useCallback(() => {
        api<{ nonce: string }>('GET', '/auth/nonce').then(d => setNonce(d.nonce)).catch(() => setError('Не удалось связаться с сервером'));
    }, []);

    useEffect(() => {
        loadNonce();
        const refresh = window.setInterval(loadNonce, 20 * 60_000);
        return () => window.clearInterval(refresh);
    }, [loadNonce]);

    useEffect(() => {
        if (window.Telegram?.Login) { setReady(true); return; }
        const s = document.createElement('script');
        s.async = true;
        s.src = SRC;
        s.onload = () => setReady(!!window.Telegram?.Login);
        s.onerror = () => setError('Не удалось загрузить скрипт Telegram (oauth.telegram.org). Проверьте соединение или VPN.');
        document.head.appendChild(s);
    }, []);

    const open = () => {
        setError('');
        // Библиотека Telegram сразу после window.open зовёт focus() у нового окна — Firefox считает это
        // второй попыткой без клика и пишет предупреждение в консоль. Окно и так открывается поверх,
        // поэтому на время вызова отключаем этот focus() (auth открывает окно синхронно, внутри try).
        const orig = window.open;
        window.open = (...args: Parameters<typeof window.open>) => {
            const w = orig.apply(window, args);
            try { if (w) w.focus = () => {}; } catch { /* окно уже чужого сайта — не мешаем */ }
            return w;
        };
        try { auth(); } finally { window.open = orig; }
    };
    const auth = () => {
        window.Telegram?.Login?.auth({ client_id: clientId, scope: ['profile'], nonce, lang: 'ru' }, r => {
            loadNonce(); // nonce одноразового окна — следующий вход получит новый
            if (r.error) { if (r.error !== 'popup_closed') setError(`Telegram: ${r.error}`); return; }
            if (!r.id_token) { setError('Telegram не вернул данные входа'); return; }
            onAuth({
                idToken: r.id_token,
                id: Number(r.user?.id) || 0,
                name: r.user?.name || r.user?.preferred_username || '',
                nick: r.user?.preferred_username ?? '',
                photo: r.user?.picture ?? null,
            });
        });
    };

    return (
        <div className="tg-slot">
            <button className="btn btn--primary btn--full tg-btn" disabled={!ready || !nonce} onClick={open}>
                <IcoTelegram /> Войти через Telegram
            </button>
            {error && <p className="login-error">{error}</p>}
        </div>
    );
}
