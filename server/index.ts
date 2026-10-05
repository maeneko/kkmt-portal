import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { migrate, pool } from './db.js';
import { loadUser } from './auth.js';
import authRoutes from './routes/auth.js';
import feedRoutes from './routes/feed.js';
import scheduleRoutes from './routes/schedule.js';
import profileRoutes from './routes/profile.js';
import adminRoutes from './routes/admin.js';
import homeworkRoutes from './routes/homework.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
    // окно входа Telegram сообщает результат через window.opener — строгий same-origin это ломает
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", 'https://oauth.telegram.org'],
            frameSrc: ['https://oauth.telegram.org'],
            imgSrc: ["'self'", 'data:', 'https://t.me', 'https://*.telesco.pe', 'https://*.telegram.org'],
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'", 'https://oauth.telegram.org'],
            upgradeInsecureRequests: null,
        },
    },
}));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use('/api', loadUser);
app.use('/api', authRoutes);
app.use('/api', feedRoutes);
app.use('/api', scheduleRoutes);
app.use('/api', profileRoutes);
app.use('/api', homeworkRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');
app.use(express.static(publicDir));
app.get('*', (_req, res) => { res.sendFile(path.join(publicDir, 'index.html')); });

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if ((err as { type?: string }).type === 'entity.too.large') { res.status(413).json({ error: 'Файл слишком большой (до 20 МБ)' }); return; }
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
});

async function start() {
    for (let i = 1; ; i++) {
        try { await migrate(); break; } catch (e) {
            if (i >= 10) throw e;
            console.error(`БД недоступна (попытка ${i}/10):`, (e as Error).message);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    // чистим просроченные сессии раз в час
    setInterval(() => { pool.query('DELETE FROM sessions WHERE expires_at < NOW()').catch(() => {}); }, 3600_000);
    const port = Number(process.env.PORT ?? 3000);
    app.listen(port, () => console.log(`kkmt слушает :${port}`));
}
start().catch(e => { console.error(e); process.exit(1); });
