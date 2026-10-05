import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../db.js';
import { createSession, destroySession, requireAuth } from '../auth.js';
import { clientId, makeNonce, verifyIdToken } from '../telegram.js';

const r = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Слишком много попыток, попробуйте позже' } });

r.get('/config', (_req, res) => {
    res.json({
        clientId: clientId(),
        groupName: process.env.GROUP_NAME ?? 'Группа',
        devLogin: process.env.DEV_LOGIN === '1',
    });
});

// nonce для входа через Telegram: попадает в id_token, защищает от подмены/повторов
r.get('/auth/nonce', (_req, res) => { res.json({ nonce: makeNonce() }); });

interface TgData {
    id: number; first_name?: string; last_name?: string; username?: string; photo_url?: string;
}

// Вход / регистрация. Новый пользователь без OWNER_TG_ID обязан передать инвайт.
async function loginOrRegister(tg: TgData, invite: unknown) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [found] = await conn.query<RowDataPacket[]>('SELECT id FROM users WHERE tg_id = ? FOR UPDATE', [tg.id]);
        let userId: number;
        if (found[0]) {
            userId = found[0].id;
            await conn.query(
                'UPDATE users SET username = ?, first_name = ?, last_name = ?, photo_url = ?, last_seen = NOW() WHERE id = ?',
                [tg.username ?? null, tg.first_name ?? '', tg.last_name ?? null, tg.photo_url ?? null, userId],
            );
        } else {
            const isOwner = String(tg.id) === process.env.OWNER_TG_ID;
            let code: string | null = null;
            if (!isOwner) {
                if (typeof invite !== 'string' || !invite) { await conn.rollback(); return { needInvite: true as const }; }
                code = invite.trim().toUpperCase();
                if (!/^[0-9A-Z]{6}$/.test(code)) { await conn.rollback(); return { badInvite: true as const }; }
                const [inv] = await conn.query<RowDataPacket[]>('SELECT code FROM invites WHERE code = ? AND used_count < max_uses FOR UPDATE', [code]);
                if (!inv[0]) { await conn.rollback(); return { badInvite: true as const }; }
            }
            const [ins] = await conn.query<ResultSetHeader>(
                'INSERT INTO users (tg_id, username, first_name, last_name, photo_url, role, invite_code) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [tg.id, tg.username ?? null, tg.first_name ?? '', tg.last_name ?? null, tg.photo_url ?? null, isOwner ? 'owner' : 'student', code],
            );
            userId = ins.insertId;
            if (code) await conn.query('UPDATE invites SET used_count = used_count + 1, used_by = ?, used_at = NOW() WHERE code = ?', [userId, code]);
        }
        await conn.commit();
        return { userId };
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}

r.post('/auth/telegram', limiter, async (req, res, next) => {
    try {
        const { idToken, invite } = req.body ?? {};
        let claims;
        try { claims = verifyIdToken(idToken); } catch (e) {
            console.warn('id_token отклонён:', (e as Error).message);
            res.status(401).json({ error: 'Вход через Telegram не подтверждён. Попробуйте ещё раз' }); return;
        }
        const tg: TgData = {
            id: claims.id,
            first_name: claims.given_name || claims.name,
            last_name: claims.family_name,
            username: claims.preferred_username,
            photo_url: claims.picture,
        };
        const result = await loginOrRegister(tg, invite);
        if ('needInvite' in result) { res.status(403).json({ needInvite: true, error: 'Нужен инвайт-ключ' }); return; }
        if ('badInvite' in result) { res.status(403).json({ needInvite: true, error: 'Неверный или использованный ключ' }); return; }
        await createSession(res, result.userId);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// Только для локальной разработки (DEV_LOGIN=1): вход без Telegram
r.post('/auth/dev', limiter, async (req, res, next) => {
    try {
        if (process.env.DEV_LOGIN !== '1') { res.status(404).end(); return; }
        const id = Number(req.body?.tgId);
        if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: 'tgId' }); return; }
        const nick = typeof req.body?.username === 'string' ? req.body.username.replace(/^@/, '').trim().slice(0, 32) : '';
        const tg: TgData = { id, first_name: String(req.body?.name || nick || `Dev ${id}`).slice(0, 64), username: nick || `dev${id}` };
        const result = await loginOrRegister(tg, req.body?.invite);
        if ('needInvite' in result) { res.status(403).json({ needInvite: true, error: 'Нужен инвайт-ключ' }); return; }
        if ('badInvite' in result) { res.status(403).json({ needInvite: true, error: 'Неверный или использованный ключ' }); return; }
        await createSession(res, result.userId);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

r.post('/auth/logout', async (req, res, next) => {
    try { await destroySession(req, res); res.json({ ok: true }); } catch (e) { next(e); }
});

r.get('/me', requireAuth, (req, res) => res.json(req.user));

export default r;
