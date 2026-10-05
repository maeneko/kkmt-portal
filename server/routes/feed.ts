import { Router } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';

const r = Router();
r.use(requireAuth);

const NAME = `COALESCE(NULLIF(u.display_name, ''), NULLIF(CONCAT_WS(' ', u.first_name, u.last_name), ''), u.username)`;

r.get('/posts', async (req, res, next) => {
    try {
        const before = Number(req.query.before) || 0;
        const limit = 10;
        const [rows] = await pool.query<RowDataPacket[]>(
            `SELECT p.id, p.body, p.pinned, p.created_at, u.id AS author_id, ${NAME} AS author_name, u.photo_url AS author_photo
             FROM posts p JOIN users u ON u.id = p.author_id
             ${before ? 'WHERE p.id < ?' : ''}
             ORDER BY ${before ? '' : 'p.pinned DESC,'} p.id DESC LIMIT ?`,
            before ? [before, limit + 1] : [limit + 1],
        );
        res.json({ posts: rows.slice(0, limit).map(p => ({ ...p, pinned: !!p.pinned })), hasMore: rows.length > limit });
    } catch (e) { next(e); }
});

r.post('/posts', requireAdmin, async (req, res, next) => {
    try {
        const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 5000) : '';
        if (!body) { res.status(400).json({ error: 'Пустой пост' }); return; }
        const [ins] = await pool.query<ResultSetHeader>(
            'INSERT INTO posts (author_id, body, pinned) VALUES (?, ?, ?)', [req.user!.id, body, req.body?.pinned ? 1 : 0]);
        res.json({ id: ins.insertId });
    } catch (e) { next(e); }
});

r.patch('/posts/:id', requireAdmin, async (req, res, next) => {
    try {
        if (req.body?.pinned !== undefined) await pool.query('UPDATE posts SET pinned = ? WHERE id = ?', [req.body.pinned ? 1 : 0, req.params.id]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

r.delete('/posts/:id', requireAdmin, async (req, res, next) => {
    try { await pool.query('DELETE FROM posts WHERE id = ?', [req.params.id]); res.json({ ok: true }); } catch (e) { next(e); }
});

export default r;
