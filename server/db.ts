import mysql from 'mysql2/promise';

for (const k of ['DB_USER', 'DB_NAME']) {
    if (!process.env[k]) {
        console.error(`Не задана переменная ${k}: проверьте .env (шаблон — .env.example) и что скрипт запущен из каталога проекта / контейнера с env_file.`);
        process.exit(1);
    }
}

export const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'kkmt',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    dateStrings: ['DATE'],
});

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tg_id BIGINT NOT NULL UNIQUE,
        username VARCHAR(64) NULL,
        first_name VARCHAR(128) NOT NULL DEFAULT '',
        last_name VARCHAR(128) NULL,
        photo_url VARCHAR(512) NULL,
        display_name VARCHAR(64) NULL,
        bio VARCHAR(500) NOT NULL DEFAULT '',
        role ENUM('student','admin','owner') NOT NULL DEFAULT 'student',
        invite_code CHAR(6) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS invites (
        code CHAR(6) PRIMARY KEY,
        created_by INT NULL,
        max_uses INT NOT NULL DEFAULT 1,
        used_count INT NOT NULL DEFAULT 0,
        used_by INT NULL,
        used_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS sessions (
        token_hash CHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        expires_at DATETIME NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS posts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        author_id INT NOT NULL,
        body TEXT NOT NULL,
        pinned TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS pair_times (
        pair_no TINYINT PRIMARY KEY,
        start_time CHAR(5) NOT NULL,
        end_time CHAR(5) NOT NULL
    ) CHARACTER SET utf8mb4`,
    // Времена пар по субботам (звонки другие); если пусто — берутся обычные из pair_times
    `CREATE TABLE IF NOT EXISTS pair_times_sat (
        pair_no TINYINT PRIMARY KEY,
        start_time CHAR(5) NOT NULL,
        end_time CHAR(5) NOT NULL
    ) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS lessons (
        id INT AUTO_INCREMENT PRIMARY KEY,
        weekday TINYINT NOT NULL,
        pair_no TINYINT NOT NULL,
        parity ENUM('all','odd','even') NOT NULL DEFAULT 'all',
        subject VARCHAR(200) NOT NULL,
        teacher VARCHAR(200) NOT NULL DEFAULT '',
        room VARCHAR(50) NOT NULL DEFAULT '',
        kind VARCHAR(30) NOT NULL DEFAULT ''
    ) CHARACTER SET utf8mb4`,
    // Дз привязано к дате и номеру пары: пересохранение расписания (новые id пар) его не теряет
    `CREATE TABLE IF NOT EXISTS homework (
        date DATE NOT NULL,
        pair_no TINYINT NOT NULL,
        body TEXT NOT NULL,
        updated_by INT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (date, pair_no),
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS homework_files (
        id INT AUTO_INCREMENT PRIMARY KEY,
        date DATE NOT NULL,
        pair_no TINYINT NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        stored_name VARCHAR(80) NOT NULL,
        size INT NOT NULL,
        uploaded_by INT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_slot (date, pair_no),
        FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4`,
    `CREATE TABLE IF NOT EXISTS settings (
        k VARCHAR(50) PRIMARY KEY,
        v VARCHAR(500) NOT NULL
    ) CHARACTER SET utf8mb4`,
];

export async function migrate(): Promise<void> {
    for (const sql of SCHEMA) await pool.query(sql);
    // колонки, добавленные позже: на уже созданных таблицах (MySQL без ADD COLUMN IF NOT EXISTS)
    const addColumn = async (table: string, column: string, ddl: string) => {
        const [r] = await pool.query<mysql.RowDataPacket[]>(
            'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]);
        if (!r.length) { await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); return true; }
        return false;
    };
    await addColumn('invites', 'max_uses', 'INT NOT NULL DEFAULT 1');
    if (await addColumn('invites', 'used_count', 'INT NOT NULL DEFAULT 0')) await pool.query('UPDATE invites SET used_count = 1 WHERE used_by IS NOT NULL');
    await addColumn('users', 'invite_code', 'CHAR(6) NULL');
    // лента без лайков и комментариев: убираем их таблицы, если остались от прежних версий
    await pool.query('DROP TABLE IF EXISTS comments');
    await pool.query('DROP TABLE IF EXISTS post_likes');
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM pair_times');
    if (rows[0].n === 0) {
        const times = [['08:30', '10:05'], ['10:15', '11:50'], ['12:20', '13:55'], ['14:05', '15:40'], ['15:50', '17:25'], ['17:35', '19:10']];
        for (const [i, [s, e]] of times.entries()) {
            await pool.query('INSERT INTO pair_times (pair_no, start_time, end_time) VALUES (?, ?, ?)', [i + 1, s, e]);
        }
    }
    await pool.query("INSERT IGNORE INTO settings (k, v) VALUES ('semester_start', ?)", [new Date().toISOString().slice(0, 10)]);
}
