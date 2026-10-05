import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';

const r = Router();
r.use(requireAuth);

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR ?? 'uploads');
export const MAX_FILE_MB = 20;
export const MAX_FILES_PER_SLOT = 5;
export const ALLOWED_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'zip', 'jpg', 'jpeg', 'png'];
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const slot = (date: unknown, pair: unknown) => {
    const p = Number(pair);
    return typeof date === 'string' && DATE.test(date) && !Number.isNaN(Date.parse(date)) && Number.isInteger(p) && p >= 1 && p <= 10 ? { date, pair: p } : null;
};

// Дз и файлы за период (для значков в расписании)
r.get('/homework', async (req, res, next) => {
    try {
        const from = String(req.query.from ?? ''), to = String(req.query.to ?? '');
        if (!DATE.test(from) || !DATE.test(to)) { res.status(400).json({ error: 'from/to' }); return; }
        const [hw] = await pool.query<RowDataPacket[]>('SELECT date, pair_no, body FROM homework WHERE date BETWEEN ? AND ?', [from, to]);
        const [files] = await pool.query<RowDataPacket[]>('SELECT id, date, pair_no, original_name AS name, size FROM homework_files WHERE date BETWEEN ? AND ? ORDER BY id', [from, to]);
        const map = new Map<string, { date: string; pair_no: number; body: string; files: unknown[] }>();
        const get = (d: string, p: number) => {
            const k = `${d}|${p}`;
            if (!map.has(k)) map.set(k, { date: d, pair_no: p, body: '', files: [] });
            return map.get(k)!;
        };
        for (const h of hw) get(h.date, h.pair_no).body = h.body;
        for (const f of files) get(f.date, f.pair_no).files.push({ id: f.id, name: f.name, size: f.size });
        res.json({ items: [...map.values()] });
    } catch (e) { next(e); }
});

r.put('/homework', requireAdmin, async (req, res, next) => {
    try {
        const s = slot(req.body?.date, req.body?.pair_no);
        if (!s) { res.status(400).json({ error: 'Некорректная дата или пара' }); return; }
        const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 5000) : '';
        if (!body) await pool.query('DELETE FROM homework WHERE date = ? AND pair_no = ?', [s.date, s.pair]);
        else await pool.query(
            'INSERT INTO homework (date, pair_no, body, updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE body = VALUES(body), updated_by = VALUES(updated_by)',
            [s.date, s.pair, body, req.user!.id]);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// Загрузка: тело запроса — сам файл, имя в ?name=
r.post('/homework/files', requireAdmin, express.raw({ type: () => true, limit: `${MAX_FILE_MB}mb` }), async (req, res, next) => {
    try {
        const s = slot(req.query.date, req.query.pair_no);
        const name = typeof req.query.name === 'string' ? path.basename(req.query.name).slice(0, 200) : '';
        const ext = path.extname(name).slice(1).toLowerCase();
        if (!s || !name) { res.status(400).json({ error: 'Некорректные параметры' }); return; }
        if (!ALLOWED_EXT.includes(ext)) { res.status(400).json({ error: `Тип .${ext || '?'} не разрешён. Можно: ${ALLOWED_EXT.join(', ')}` }); return; }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) { res.status(400).json({ error: 'Пустой файл' }); return; }
        const [cnt] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM homework_files WHERE date = ? AND pair_no = ?', [s.date, s.pair]);
        if (cnt[0].n >= MAX_FILES_PER_SLOT) { res.status(400).json({ error: `Не больше ${MAX_FILES_PER_SLOT} файлов на пару` }); return; }
        const stored = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
        await fs.promises.writeFile(path.join(UPLOAD_DIR, stored), req.body);
        const [ins] = await pool.query<ResultSetHeader>(
            'INSERT INTO homework_files (date, pair_no, original_name, stored_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
            [s.date, s.pair, name, stored, req.body.length, req.user!.id]);
        res.json({ id: ins.insertId, name, size: req.body.length });
    } catch (e) { next(e); }
});

r.get('/homework/files/:id', async (req, res, next) => {
    try {
        const [rows] = await pool.query<RowDataPacket[]>('SELECT original_name, stored_name FROM homework_files WHERE id = ?', [req.params.id]);
        if (!rows[0]) { res.status(404).json({ error: 'Файл не найден' }); return; }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rows[0].original_name)}`);
        res.sendFile(path.join(UPLOAD_DIR, rows[0].stored_name), e => { if (e && !res.headersSent) res.status(404).json({ error: 'Файл не найден' }); });
    } catch (e) { next(e); }
});

r.delete('/homework/files/:id', requireAdmin, async (req, res, next) => {
    try {
        const [rows] = await pool.query<RowDataPacket[]>('SELECT stored_name FROM homework_files WHERE id = ?', [req.params.id]);
        if (rows[0]) {
            await pool.query('DELETE FROM homework_files WHERE id = ?', [req.params.id]);
            await fs.promises.unlink(path.join(UPLOAD_DIR, rows[0].stored_name)).catch(() => {});
        }
        res.json({ ok: true });
    } catch (e) { next(e); }
});

export default r;
