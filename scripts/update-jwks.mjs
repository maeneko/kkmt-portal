// Обновляет server/telegram_jwks.json из https://oauth.telegram.org/.well-known/jwks.json (запускать там, где Telegram доступен).
// Ключи вшиты в бинарник, потому что с боевого сервера Telegram недоступен.
import { writeFileSync } from 'node:fs';
const res = await fetch('https://oauth.telegram.org/.well-known/jwks.json');
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const keys = (await res.json()).keys
    .filter(k => k.alg === 'RS256' || k.alg === 'ES256')
    .map(({ kty, kid, alg, n, e, x, y, crv }) => Object.fromEntries(Object.entries({ kty, kid, alg, n, e, x, y, crv }).filter(([, v]) => v !== undefined)));
writeFileSync(new URL('../server/telegram_jwks.json', import.meta.url), JSON.stringify(keys, null, 4) + '\n');
console.log(`Ключей записано: ${keys.length}`);
