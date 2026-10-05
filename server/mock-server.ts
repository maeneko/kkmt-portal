// Мок-сервер БЕЗ MySQL: те же /api-эндпоинты, данные в памяти (сбрасываются при перезапуске).
//   npm run dev:mock   — мок + Vite;  вход автоматический (владелец), «Выйти» → «Dev вход».
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { LESSONS, SAT_TIMES, TIMES, semesterStart } from './mock-data.js';

type Role = 'student' | 'admin' | 'owner';
interface U { id: number; username: string | null; first_name: string; last_name: string | null; display_name: string | null; photo_url: string | null; bio: string; role: Role }
interface Post { id: number; author_id: number; body: string; pinned: boolean; created_at: string }

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const users: U[] = [
    { id: 1, username: 'starosta', first_name: 'Иван', last_name: 'Васильев', display_name: null, photo_url: null, bio: 'Староста группы', role: 'owner' },
    { id: 2, username: 'anna_k', first_name: 'Анна', last_name: 'Ковалёва', display_name: null, photo_url: null, bio: 'Заместитель старосты', role: 'admin' },
    { id: 3, username: 'max_s', first_name: 'Максим', last_name: 'Соколов', display_name: null, photo_url: null, bio: '', role: 'student' },
    { id: 4, username: 'olga_p', first_name: 'Ольга', last_name: 'Павлова', display_name: null, photo_url: null, bio: 'Люблю базы данных', role: 'student' },
    { id: 5, username: 'dima_r', first_name: 'Дмитрий', last_name: 'Романов', display_name: null, photo_url: null, bio: '', role: 'student' },
];
let me = users[0];
let loggedIn = true;
let nextId = 100;

const posts: Post[] = [
    { id: 1, author_id: 1, body: 'Добро пожаловать на портал группы! Здесь будут расписание и важные объявления.', pinned: true, created_at: ago(60 * 48) },
    { id: 2, author_id: 2, body: 'В пятницу вместо 2 пары — консультация по проекту, аудитория 112.', pinned: false, created_at: ago(60 * 20) },
    { id: 3, author_id: 1, body: 'Сдача лабораторных по базам данных до конца месяца. Не затягивайте!', pinned: false, created_at: ago(60 * 5) },
];
let lessons = LESSONS.map((l, i) => ({ id: i + 1, weekday: l[0], pair_no: l[1], parity: l[2], subject: l[3], teacher: l[4], room: l[5], kind: l[6] }));
let times = TIMES.map(([s, e], i) => ({ pair_no: i + 1, start_time: s, end_time: e }));
const satTimes = SAT_TIMES.map(([s, e], i) => ({ pair_no: i + 1, start_time: s, end_time: e }));
let semStart = semesterStart();
let invites: { code: string; created_at: string; max_uses: number; used_count: number; used_by: string[] }[] = [
    { code: 'K7M2QX', created_at: ago(60 * 70), max_uses: 1, used_count: 1, used_by: ['Максим Соколов'] },
    { code: 'A9B3Z1', created_at: ago(60 * 3), max_uses: 5, used_count: 2, used_by: ['Ольга Павлова', 'Дмитрий Романов'] },
];

const name = (u: U) => u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';
const byId = (id: number) => users.find(u => u.id === id)!;
const isAdm = () => me.role !== 'student';
const ALPH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const app = express();
app.use(express.json());
const api = express.Router();
app.use('/api', api);

api.get('/config', (_q, r) => { r.json({ clientId: '', groupName: 'ИС-21', devLogin: true }); });
api.post('/auth/dev', (_q, r) => { loggedIn = true; r.json({ ok: true }); });
api.post('/auth/logout', (_q, r) => { loggedIn = false; r.json({ ok: true }); });
api.use((_q, r, n) => { if (!loggedIn) { r.status(401).json({ error: 'Не авторизован' }); return; } n(); });
api.get('/me', (_q, r) => { r.json(me); });

const admin: express.RequestHandler = (_q, r, n) => { if (!isAdm()) { r.status(403).json({ error: 'Только для админов' }); return; } n(); };
const pubPost = (p: Post) => ({
    id: p.id, body: p.body, pinned: p.pinned, created_at: p.created_at, author_id: p.author_id,
    author_name: name(byId(p.author_id)), author_photo: null,
});

api.get('/posts', (q, r) => {
    const before = Number(q.query.before) || 0;
    let list = [...posts].sort((a, b) => before ? b.id - a.id : Number(b.pinned) - Number(a.pinned) || b.id - a.id);
    if (before) list = list.filter(p => p.id < before);
    r.json({ posts: list.slice(0, 10).map(pubPost), hasMore: list.length > 10 });
});
api.post('/posts', admin, (q, r) => {
    const body = String(q.body.body ?? '').trim();
    if (!body) { r.status(400).json({ error: 'Пустой пост' }); return; }
    const p: Post = { id: nextId++, author_id: me.id, body, pinned: !!q.body.pinned, created_at: new Date().toISOString() };
    posts.push(p); r.json({ id: p.id });
});
api.patch('/posts/:id', admin, (q, r) => {
    const p = posts.find(x => x.id === Number(q.params.id));
    if (p) { if (q.body.body !== undefined) p.body = String(q.body.body); if (q.body.pinned !== undefined) p.pinned = !!q.body.pinned; }
    r.json({ ok: true });
});
api.delete('/posts/:id', admin, (q, r) => {
    const i = posts.findIndex(x => x.id === Number(q.params.id));
    if (i >= 0) posts.splice(i, 1);
    r.json({ ok: true });
});

// Домашнее задание и файлы — в памяти
const hwBody = new Map<string, string>();
const hwFiles: { id: number; date: string; pair_no: number; name: string; data: Buffer }[] = [];
const dayOffset = (n: number) => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
hwBody.set(`${dayOffset(1)}|2`, 'Решить задачи 5–9 из практикума, подготовить таблицу связей для ER-диаграммы.');
hwBody.set(`${dayOffset(0)}|1`, 'Конспект лекции, повторить пределы.');
hwFiles.push({ id: 1, date: dayOffset(1), pair_no: 2, name: 'Практикум по базам данных.pdf', data: Buffer.from('%PDF-1.4 mock') });
const EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'zip', 'jpg', 'jpeg', 'png'];
api.get('/homework', (q, r) => {
    const from = String(q.query.from), to = String(q.query.to);
    const map = new Map<string, { date: string; pair_no: number; body: string; files: { id: number; name: string; size: number }[] }>();
    const slot = (d: string, p: number) => { const k = `${d}|${p}`; if (!map.has(k)) map.set(k, { date: d, pair_no: p, body: '', files: [] }); return map.get(k)!; };
    for (const [k, v] of hwBody) { const [d, p] = k.split('|'); if (d >= from && d <= to) slot(d, Number(p)).body = v; }
    for (const f of hwFiles) if (f.date >= from && f.date <= to) slot(f.date, f.pair_no).files.push({ id: f.id, name: f.name, size: f.data.length });
    r.json({ items: [...map.values()] });
});
api.put('/homework', admin, (q, r) => {
    const k = `${q.body.date}|${q.body.pair_no}`, b = String(q.body.body ?? '').trim();
    if (b) hwBody.set(k, b); else hwBody.delete(k);
    r.json({ ok: true });
});
api.post('/homework/files', admin, express.raw({ type: () => true, limit: '20mb' }), (q, r) => {
    const name = String(q.query.name ?? ''), ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (!EXT.includes(ext)) { r.status(400).json({ error: `Тип .${ext} не разрешён. Можно: ${EXT.join(', ')}` }); return; }
    const date = String(q.query.date), pair_no = Number(q.query.pair_no);
    if (hwFiles.filter(f => f.date === date && f.pair_no === pair_no).length >= 5) { r.status(400).json({ error: 'Не больше 5 файлов на пару' }); return; }
    const f = { id: nextId++, date, pair_no, name, data: Buffer.isBuffer(q.body) ? q.body : Buffer.alloc(0) };
    hwFiles.push(f); r.json({ id: f.id, name, size: f.data.length });
});
api.get('/homework/files/:id', (q, r) => {
    const f = hwFiles.find(x => x.id === Number(q.params.id));
    if (!f) { r.status(404).json({ error: 'Файл не найден' }); return; }
    r.setHeader('Content-Type', 'application/octet-stream');
    r.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    r.send(f.data);
});
api.delete('/homework/files/:id', admin, (q, r) => {
    const i = hwFiles.findIndex(x => x.id === Number(q.params.id));
    if (i >= 0) hwFiles.splice(i, 1);
    r.json({ ok: true });
});

api.get('/schedule', (_q, r) => { r.json({ lessons, times, satTimes, semesterStart: semStart }); });
api.get('/users', (_q, r) => { r.json(users); });
api.get('/users/:id', (q, r) => { const u = users.find(x => x.id === Number(q.params.id)); u ? r.json(u) : r.status(404).json({ error: 'Не найдено' }); });
api.patch('/me', (q, r) => { me.display_name = String(q.body.display_name ?? '').trim() || null; r.json({ ok: true }); });

const adm = express.Router();
adm.use(admin);
api.use('/admin', adm);
adm.get('/invites', (_q, r) => { r.json(invites); });
adm.post('/invites', (q, r) => {
    const max = Math.floor(Number(q.body.max_uses ?? 1));
    if (!(max >= 1 && max <= 1000)) { r.status(400).json({ error: 'Количество использований: от 1 до 1000' }); return; }
    const code = Array.from({ length: 6 }, () => ALPH[Math.floor(Math.random() * ALPH.length)]).join('');
    invites.unshift({ code, created_at: new Date().toISOString(), max_uses: max, used_count: 0, used_by: [] });
    r.json({ code, max_uses: max });
});
adm.delete('/invites/:code', (q, r) => { invites = invites.filter(i => i.code !== q.params.code); r.json({ ok: true }); });
adm.get('/users', (_q, r) => { r.json(users); });
adm.patch('/users/:id', (q, r) => {
    if (me.role !== 'owner') { r.status(403).json({ error: 'Только главный админ' }); return; }
    const u = users.find(x => x.id === Number(q.params.id));
    if (u && u.role !== 'owner' && (q.body.role === 'admin' || q.body.role === 'student')) u.role = q.body.role;
    r.json({ ok: true });
});
adm.delete('/users/:id', (q, r) => {
    const i = users.findIndex(x => x.id === Number(q.params.id));
    if (i >= 0 && users[i].role !== 'owner') users.splice(i, 1);
    r.json({ ok: true });
});
adm.put('/schedule', (q, r) => {
    lessons = (q.body.lessons ?? []).map((l: Record<string, unknown>, i: number) => ({
        id: i + 1, weekday: Number(l.weekday), pair_no: Number(l.pair_no), parity: (l.parity === 'odd' || l.parity === 'even' ? l.parity : 'all') as 'all' | 'odd' | 'even',
        subject: String(l.subject ?? ''), teacher: String(l.teacher ?? ''), room: String(l.room ?? ''), kind: String(l.kind ?? ''),
    }));
    r.json({ ok: true });
});
adm.put('/pair-times', (q, r) => {
    times = (q.body.times ?? []).map((t: { start_time: string; end_time: string }, i: number) => ({ pair_no: i + 1, start_time: t.start_time, end_time: t.end_time }));
    r.json({ ok: true });
});
adm.put('/settings', (q, r) => { if (typeof q.body.semester_start === 'string') semStart = q.body.semester_start; r.json({ ok: true }); });

// Собранный фронт (npm run build), если он есть: тогда мок открывается и без Vite
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
app.use(express.static(publicDir));
app.get('*', (_q, r) => { r.sendFile(path.join(publicDir, 'index.html'), e => { if (e) r.status(404).end(); }); });

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`kkmt MOCK (без БД) слушает :${port}`));
