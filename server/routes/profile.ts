import { Router } from 'express';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';

const r = Router();
r.use(requireAuth);

const PUBLIC = 'id, username, photo_url, display_name, first_name, last_name, bio, role';

r.get('/users', async (_req, res, next) => {
    try {
        const [rows] = await pool.query<RowDataPacket[]>(`SELECT ${PUBLIC} FROM users ORDER BY FIELD(role,'owner','admin','student'), first_name`);
        res.json(rows);
    } catch (e) { next(e); }
});

r.get('/users/:id', async (req, res, next) => {
    try {
        const [rows] = await pool.query<RowDataPacket[]>(`SELECT ${PUBLIC} FROM users WHERE id = ?`, [req.params.id]);
        if (!rows[0]) { res.status(404).json({ error: 'Не найдено' }); return; }
        res.json(rows[0]);
    } catch (e) { next(e); }
});

r.patch('/me', async (req, res, next) => {
    try {
        const name = typeof req.body?.display_name === 'string' ? Array.from(req.body.display_name.trim()).slice(0, 32).join('') : '';
        await pool.query('UPDATE users SET display_name = ? WHERE id = ?', [name || null, req.user!.id]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

export default r;
