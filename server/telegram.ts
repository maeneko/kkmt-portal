import crypto from 'node:crypto';
import { TELEGRAM_JWKS, type TgJwk } from './telegram-jwks.js';

// «Log In With Telegram» (OpenID Connect): сайт получает от Telegram подписанный id_token (JWT), сервер проверяет подпись
// по встроенным ключам Telegram, iss/aud/exp и nonce. Секрет клиента здесь не нужен.

export interface TelegramClaims {
    id: number; name: string; given_name?: string; family_name?: string; preferred_username?: string; picture?: string;
}

const ISS = 'https://oauth.telegram.org';
const NONCE_TTL_MS = 30 * 60_000;
const b64u = (s: string) => Buffer.from(s, 'base64url');

// Client ID из BotFather (раздел Login Widget). Если не задан — пробуем id бота из токена (у новых ботов они совпадают).
export function clientId(): string {
    return process.env.TELEGRAM_CLIENT_ID || /^\d+/.exec(process.env.BOT_TOKEN ?? '')?.[0] || '';
}

// nonce без хранения состояния: exp.rand.hmac. Ключ случайный на время жизни процесса.
const nonceKey = crypto.randomBytes(32);
const mac = (body: string) => crypto.createHmac('sha256', nonceKey).update(body).digest('base64url');

export function makeNonce(): string {
    const body = `${Date.now() + NONCE_TTL_MS}.${crypto.randomBytes(12).toString('base64url')}`;
    return `${body}.${mac(body)}`;
}

export function checkNonce(nonce: unknown): boolean {
    if (typeof nonce !== 'string') return false;
    const [exp, rand, sig] = nonce.split('.');
    if (!exp || !rand || !sig) return false;
    const given = Buffer.from(sig), want = Buffer.from(mac(`${exp}.${rand}`));
    return given.length === want.length && crypto.timingSafeEqual(given, want) && Number(exp) > Date.now();
}

export function verifyIdToken(token: unknown, opts: { keys?: TgJwk[]; clientId?: string; now?: number } = {}): TelegramClaims {
    const keys = opts.keys ?? TELEGRAM_JWKS;
    const cid = opts.clientId ?? clientId();
    const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
    if (!cid) throw new Error('client_id не настроен');
    if (typeof token !== 'string' || token.length > 4096) throw new Error('формат токена');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('формат токена');

    const header = JSON.parse(b64u(parts[0]).toString('utf8')) as { alg?: string; kid?: string };
    if (header.alg !== 'RS256' && header.alg !== 'ES256') throw new Error('алгоритм');
    const jwk = keys.find(k => k.kid === header.kid && k.alg === header.alg);
    if (!jwk) throw new Error('ключ не найден');
    const key = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: 'jwk' });
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = b64u(parts[2]);
    const ok = header.alg === 'RS256'
        ? crypto.verify('RSA-SHA256', data, key, sig)
        : crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    if (!ok) throw new Error('подпись');

    const c = JSON.parse(b64u(parts[1]).toString('utf8')) as Record<string, unknown>;
    if (c.iss !== ISS) throw new Error('iss');
    const aud = Array.isArray(c.aud) ? c.aud.map(String) : [String(c.aud)];
    if (!aud.includes(String(cid))) throw new Error('aud');
    if (typeof c.exp !== 'number' || c.exp <= nowSec) throw new Error('срок действия');
    if (typeof c.iat === 'number' && c.iat > nowSec + 60) throw new Error('iat');
    if (!checkNonce(c.nonce)) throw new Error('nonce');
    const id = Number(c.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('нет id (нужен scope profile)');
    return {
        id, name: String(c.name ?? ''), given_name: c.given_name as string | undefined, family_name: c.family_name as string | undefined,
        preferred_username: c.preferred_username as string | undefined, picture: c.picture as string | undefined,
    };
}
