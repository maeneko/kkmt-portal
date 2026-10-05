// Мок-расписание для демо: перезаписывает пары, время пар и дату начала семестра.
//   dev:   npm run seed:mock
//   сервер: docker compose exec kkmt node dist/server/seed-mock.js
import 'dotenv/config';
import { migrate, pool } from './db.js';
import { LESSONS, SAT_TIMES, TIMES, semesterStart } from './mock-data.js';

async function main() {
    await migrate();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM lessons');
        await conn.query('INSERT INTO lessons (weekday, pair_no, parity, subject, teacher, room, kind) VALUES ?', [LESSONS]);
        await conn.query('DELETE FROM pair_times');
        await conn.query('INSERT INTO pair_times (pair_no, start_time, end_time) VALUES ?', [TIMES.map(([s, e], i) => [i + 1, s, e])]);
        await conn.query('DELETE FROM pair_times_sat');
        await conn.query('INSERT INTO pair_times_sat (pair_no, start_time, end_time) VALUES ?', [SAT_TIMES.map(([s, e], i) => [i + 1, s, e])]);
        await conn.query("INSERT INTO settings (k, v) VALUES ('semester_start', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [semesterStart()]);
        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
    console.log(`Мок-расписание записано: ${LESSONS.length} пар, начало семестра ${semesterStart()}`);
    await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
