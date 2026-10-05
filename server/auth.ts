import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { RowDataPacket } from 'mysql2';
import { pool } from './db.js';

export interface User {
    id: number;
    tg_id: number;
    username: string | null;
    first_name: string;
    last_name: string | null;
    photo_url: string | null;
    display_name: string | null;
    bio: string;
    role: 'student' | 'admin' | 'owner';
}

declare module 'express-serve-static-core' {
    interface Request { user?: User }
}

export const COOKIE = 'kkmt_session';
const SESSION_DAYS = 30;
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(res: Response, userId: number): Promise<void> {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
        'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))',
        [sha256(token), userId, SESSION_DAYS],
    );
    res.cookie(COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.COOKIE_SECURE === '1',
        maxAge: SESSION_DAYS * 86400_000,
    });
}

export async function destroySession(req: Request, res: Response): Promise<void> {
    const token = req.cookies?.[COOKIE];
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
    res.clearCookie(COOKIE);
}

export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
        const token = req.cookies?.[COOKIE];
        if (typeof token === 'string' && token) {
            const [rows] = await pool.query<RowDataPacket[]>(
                `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = ? AND s.expires_at > NOW()`,
                [sha256(token)],
            );
            if (rows[0]) req.user = rows[0] as User;
        }
        next();
    } catch (e) { next(e); }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) { res.status(401).json({ error: 'Не авторизован' }); return; }
    next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) { res.status(401).json({ error: 'Не авторизован' }); return; }
    if (req.user.role === 'student') { res.status(403).json({ error: 'Только для админов' }); return; }
    next();
}

export const isAdmin = (u: User) => u.role !== 'student';
