import { Router } from 'express';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';

const r = Router();

r.get('/schedule', requireAuth, async (_req, res, next) => {
    try {
        const [lessons] = await pool.query<RowDataPacket[]>('SELECT id, weekday, pair_no, parity, subject, teacher, room, kind FROM lessons ORDER BY weekday, pair_no');
        const [times] = await pool.query<RowDataPacket[]>('SELECT pair_no, start_time, end_time FROM pair_times ORDER BY pair_no');
        const [satTimes] = await pool.query<RowDataPacket[]>('SELECT pair_no, start_time, end_time FROM pair_times_sat ORDER BY pair_no');
        const [settings] = await pool.query<RowDataPacket[]>("SELECT v FROM settings WHERE k = 'semester_start'");
        res.json({ lessons, times, satTimes, semesterStart: settings[0]?.v ?? null });
    } catch (e) { next(e); }
});

export default r;
