import crypto from 'node:crypto';
import { Router } from 'express';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../db.js';
import { requireAdmin } from '../auth.js';

const r = Router();
r.use(requireAdmin);

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const genCode = () => Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

r.get('/invites', async (_req, res, next) => {
    try {
        const [rows] = await pool.query<RowDataPacket[]>('SELECT code, created_at, max_uses, used_count FROM invites ORDER BY created_at DESC');
        const [users] = await pool.query<RowDataPacket[]>(
            "SELECT invite_code, COALESCE(NULLIF(display_name,''), NULLIF(CONCAT_WS(' ', first_name, last_name), ''), username) AS name FROM users WHERE invite_code IS NOT NULL ORDER BY id");
        const byCode = new Map<string, string[]>();
        for (const u of users) byCode.set(u.invite_code, [...(byCode.get(u.invite_code) ?? []), u.name]);
        res.json(rows.map(i => ({ ...i, used_by: byCode.get(i.code) ?? [] })));
    } catch (e) { next(e); }
});

r.post('/invites', async (req, res, next) => {
    try {
        const maxUses = Math.floor(Number(req.body?.max_uses ?? 1));
        if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 1000) { res.status(400).json({ error: 'Количество использований: от 1 до 1000' }); return; }
        for (let i = 0; i < 10; i++) {
            const code = genCode();
            try {
                await pool.query('INSERT INTO invites (code, created_by, max_uses) VALUES (?, ?, ?)', [code, req.user!.id, maxUses]);
                res.json({ code, max_uses: maxUses }); return;
            } catch (e) {
                if ((e as { code?: string }).code !== 'ER_DUP_ENTRY') throw e;
            }
        }
        res.status(500).json({ error: 'Не удалось сгенерировать ключ' });
    } catch (e) { next(e); }
});

r.delete('/invites/:code', async (req, res, next) => {
    try { await pool.query('DELETE FROM invites WHERE code = ?', [req.params.code]); res.json({ ok: true }); } catch (e) { next(e); }
});

r.get('/users', async (_req, res, next) => {
    try {
        const [rows] = await pool.query<RowDataPacket[]>(
            "SELECT id, username, first_name, last_name, display_name, photo_url, role FROM users ORDER BY FIELD(role,'owner','admin','student'), first_name");
        res.json(rows);
    } catch (e) { next(e); }
});

async function targetUser(id: string) {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT id, role FROM users WHERE id = ?', [id]);
    return rows[0];
}

r.patch('/users/:id', async (req, res, next) => {
    try {
        if (req.user!.role !== 'owner') { res.status(403).json({ error: 'Только главный админ' }); return; }
        const role = req.body?.role;
        if (role !== 'student' && role !== 'admin') { res.status(400).json({ error: 'role' }); return; }
        const t = await targetUser(req.params.id);
        if (!t) { res.status(404).json({ error: 'Не найдено' }); return; }
        if (t.role === 'owner') { res.status(403).json({ error: 'Главного админа менять нельзя' }); return; }
        await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, t.id]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

r.delete('/users/:id', async (req, res, next) => {
    try {
        const t = await targetUser(req.params.id);
        if (!t) { res.status(404).json({ error: 'Не найдено' }); return; }
        if (t.role === 'owner') { res.status(403).json({ error: 'Главного админа удалить нельзя' }); return; }
        if (t.role === 'admin' && req.user!.role !== 'owner') { res.status(403).json({ error: 'Админа удаляет только главный админ' }); return; }
        await pool.query('DELETE FROM users WHERE id = ?', [t.id]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

r.put('/schedule', async (req, res, next) => {
    const list: unknown = req.body?.lessons;
    if (!Array.isArray(list) || list.length > 300) { res.status(400).json({ error: 'lessons' }); return; }
    const rows: (string | number)[][] = [];
    for (const l of list as Record<string, unknown>[]) {
        const weekday = Number(l.weekday), pair = Number(l.pair_no), subject = str(l.subject, 200);
        if (!(weekday >= 1 && weekday <= 6) || !(pair >= 1 && pair <= 10) || !subject) { res.status(400).json({ error: 'Некорректная пара' }); return; }
        const parity = l.parity === 'odd' || l.parity === 'even' ? l.parity : 'all';
        rows.push([weekday, pair, parity, subject, str(l.teacher, 200), str(l.room, 50), str(l.kind, 30)]);
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM lessons');
        if (rows.length) await conn.query('INSERT INTO lessons (weekday, pair_no, parity, subject, teacher, room, kind) VALUES ?', [rows]);
        await conn.commit();
        res.json({ ok: true });
    } catch (e) { await conn.rollback(); next(e); } finally { conn.release(); }
});

r.put('/pair-times', async (req, res, next) => {
    try {
        const list: unknown = req.body?.times;
        if (!Array.isArray(list) || list.length > 10) { res.status(400).json({ error: 'times' }); return; }
        const rows: (string | number)[][] = [];
        for (const [i, t] of (list as Record<string, unknown>[]).entries()) {
            if (typeof t.start_time !== 'string' || typeof t.end_time !== 'string' || !TIME.test(t.start_time) || !TIME.test(t.end_time)) {
                res.status(400).json({ error: 'Время в формате ЧЧ:ММ' }); return;
            }
            rows.push([i + 1, t.start_time, t.end_time]);
        }
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.query('DELETE FROM pair_times');
            if (rows.length) await conn.query('INSERT INTO pair_times (pair_no, start_time, end_time) VALUES ?', [rows]);
            await conn.commit();
        } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
        res.json({ ok: true });
    } catch (e) { next(e); }
});

r.put('/settings', async (req, res, next) => {
    try {
        const d = req.body?.semester_start;
        if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) { res.status(400).json({ error: 'Дата ГГГГ-ММ-ДД' }); return; }
        await pool.query("INSERT INTO settings (k, v) VALUES ('semester_start', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [d]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

export default r;
