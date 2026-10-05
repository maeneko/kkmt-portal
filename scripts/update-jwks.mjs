// Обновляет server/telegram-jwks.ts из https://oauth.telegram.org/.well-known/jwks.json (запускать там, где Telegram доступен).
import { writeFileSync } from 'node:fs';
const res = await fetch('https://oauth.telegram.org/.well-known/jwks.json');
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const keys = (await res.json()).keys
    .filter(k => k.alg === 'RS256' || k.alg === 'ES256')
    .map(({ kty, kid, alg, n, e, x, y, crv }) => Object.fromEntries(Object.entries({ kty, kid, alg, n, e, x, y, crv }).filter(([, v]) => v !== undefined)));
writeFileSync(new URL('../server/telegram-jwks.ts', import.meta.url), `// Публичные ключи Telegram для проверки подписи id_token (https://oauth.telegram.org/.well-known/jwks.json).
// Встроены, потому что с боевого сервера Telegram недоступен. Обновить: npm run update-jwks
export interface TgJwk { kty: string; kid: string; alg: string; n?: string; e?: string; x?: string; y?: string; crv?: string }
export const TELEGRAM_JWKS: TgJwk[] = ${JSON.stringify(keys, null, 4)};
`);
console.log(`Ключей записано: ${keys.length}`);
