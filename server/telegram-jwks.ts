// Публичные ключи Telegram для проверки подписи id_token (https://oauth.telegram.org/.well-known/jwks.json).
// Встроены, потому что с боевого сервера Telegram недоступен. Обновить: npm run update-jwks
export interface TgJwk { kty: string; kid: string; alg: string; n?: string; e?: string; x?: string; y?: string; crv?: string }
export const TELEGRAM_JWKS: TgJwk[] = [
    {
        "alg": "RS256",
        "e": "AQAB",
        "kty": "RSA",
        "n": "5RneLtsKvVcxdv6gu6gxEQu30Cru5NiMQnY6SNr9ZyZFZ4ya-pfHNuaZXJ6QPG0JSFwoxeOkEO2-eZN_REVPm448PvjjsR1eQdZ5QpEkNxnItFcmxkHH91v5cgf52_EI9BGO-MT6f1vaBSg3uWHFlDxI7J2AYxNvd1_Nf3TkgrrR7gyJFTmEIai5RefGnA0KGNYDlRIGUzrz2F05n6gTaHFT_iHL5UHatTZA4GCiUSjIOuwqu5pE5uZge20TFv3cxXMQaFw_xv1pgQt_Rq8eoCN7TS0RQ0zjWKiad-W286BcFectXsUm03p5Nq_kY4mf_7rqwX_B8yy_bBreyKn7RQ",
        "kid": "oidc-1"
    },
    {
        "alg": "ES256",
        "kty": "EC",
        "x": "ahVYrohhX6YA7w0P2gUNSwMFbaabCgBZFkeq9bWdmwU",
        "y": "Ea8nKJ34VQMA7zv8aYDfzcBhXEjnWQ9C06jVke_eUV0",
        "crv": "P-256",
        "kid": "oidc-es256-1"
    }
];
