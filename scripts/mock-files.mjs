// Мок-данные для проверки файлов и «Материалов»: ДЗ и файлы к парам за 3 прошлые недели и текущую,
// а к каждому второму мок-заданию — эталонное решение (текст и файл).
// Нужен запущенный сервер с DEV_LOGIN=1; входит как dev-пользователь (по умолчанию tgId 1 — админ).
//   node scripts/mock-files.mjs          — добавить (пары, где уже есть файлы, пропускаются)
//   node scripts/mock-files.mjs --clean  — удалить всё мок-ДЗ и файлы «mock-*»
const API = process.env.API ?? 'http://localhost:3000/api';
const clean = process.argv.includes('--clean');

const login = await fetch(`${API}/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tgId: Number(process.env.TG_ID ?? 1) }) });
if (!login.ok) throw new Error(`Вход: HTTP ${login.status} (включён ли DEV_LOGIN=1?)`);
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = async (method, url, body, type = 'application/json') => {
    const res = await fetch(`${API}${url}`, { method, headers: { Cookie: cookie, 'Content-Type': type }, body: type === 'application/json' && body !== undefined ? JSON.stringify(body) : body });
    if (!res.ok) throw new Error(`${method} ${url}: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
    return res.json();
};

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = new Date(); today.setHours(0, 0, 0, 0);
const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
const from = new Date(monday); from.setDate(monday.getDate() - 21);
const to = new Date(monday); to.setDate(monday.getDate() + 5);
const { items } = await api('GET', `/homework?from=${iso(from)}&to=${iso(to)}`);

if (clean) {
    let files = 0, hw = 0;
    for (const it of items) {
        for (const f of it.files) if (f.name.startsWith('mock-')) { await api('DELETE', `/homework/files/${f.id}`); files++; }
        if (it.body.startsWith('Мок:')) { await api('PUT', '/homework', { date: it.date, pair_no: it.pair_no, body: '' }); hw++; }
    }
    console.log(`Удалено: файлов ${files}, ДЗ и решений ${hw}`);
    process.exit(0);
}

// Небольшие, но настоящие файлы: открываются в просмотрщиках
const pdf = text => {
    const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    let out = '%PDF-1.4\n';
    const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    return out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const NOTES = ['решить задания 1–3 на стр. 2', 'ответить на контрольные вопросы в конце', 'заполнить таблицу и сдать на паре', 'прочитать раздел 2, конспект от руки'];
const TASKS = ['прочитать конспект лекции', 'решить задачи 1–5', 'подготовить отчёт по лабораторной', 'выучить термины', 'доделать практическую работу'];

const { lessons, semesterStart } = await api('GET', '/schedule');
// чётность недели — как на фронтенде: 1-я неделя семестра нечётная
const week = d => {
    if (!semesterStart) return 1;
    const s = new Date(`${semesterStart}T00:00:00`); s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
    const m = new Date(d); m.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return Math.round((m - s) / (7 * 86400_000)) + 1;
};
const has = new Set(items.filter(i => i.files.length).map(i => `${i.date}|${i.pair_no}`));

let added = 0, n = 0;
for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const wd = (d.getDay() + 6) % 7 + 1, parity = week(d) % 2 ? 'odd' : 'even', date = iso(d);
    for (const l of lessons.filter(l => l.weekday === wd && (l.parity === 'all' || l.parity === parity))) {
        if (n++ % 2 || has.has(`${date}|${l.pair_no}`)) continue; // каждая вторая пара, без повторов
        const short = l.subject.split(' ').slice(0, 3).join('-').replace(/[^\p{L}\d.-]/gu, '');
        await api('PUT', '/homework', { date, pair_no: l.pair_no, body: `Мок: ${TASKS[n % TASKS.length]} (${l.subject})` });
        const files = [[`mock-${short}-${date}.pdf`, pdf(`Mock ${date} pair ${l.pair_no}`)], [`mock-notes-${date}.txt`, `Мок-конспект: ${l.subject}\n${date}, ${l.pair_no} пара\n`]];
        if (n % 3 === 0) files.push([`mock-photo-${date}.png`, png]);
        for (const [name, body] of files) {
            const f = await api('POST', `/homework/files?date=${date}&pair_no=${l.pair_no}&name=${encodeURIComponent(name)}`, body, 'application/octet-stream');
            if (name.endsWith('.pdf')) await api('PATCH', `/homework/files/${f.id}`, { note: `Мок: ${NOTES[n % NOTES.length]}` });
            added++;
        }
    }
}

// Эталонное решение пары N лежит в слоте с номером пары N + 100
const SOL = 100;
const { items: all } = await api('GET', `/homework?from=${iso(from)}&to=${iso(to)}`);
const solved = new Set(all.filter(i => i.pair_no > SOL && (i.body || i.files.length)).map(i => `${i.date}|${i.pair_no - SOL}`));
let sols = 0, k = 0;
for (const it of all.filter(i => i.pair_no <= SOL && i.body.startsWith('Мок:'))) {
    if (k++ % 2 || solved.has(`${it.date}|${it.pair_no}`)) continue; // каждое второе, без повторов
    const pair = it.pair_no + SOL;
    await api('PUT', '/homework', { date: it.date, pair_no: pair, body: `Мок: решение — сначала разобрать пример из лекции, затем повторить шаги 1–3 и сверить ответ.` });
    const f = await api('POST', `/homework/files?date=${it.date}&pair_no=${pair}&name=mock-solution-${it.date}-${it.pair_no}.pdf`, pdf(`Mock solution ${it.date} pair ${it.pair_no}`), 'application/octet-stream');
    await api('PATCH', `/homework/files/${f.id}`, { note: 'Мок: эталонный ответ' });
    sols++;
}
console.log(`Добавлено файлов: ${added}, решений: ${sols}. Удалить: node scripts/mock-files.mjs --clean`);
