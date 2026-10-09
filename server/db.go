package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/jmoiron/sqlx"
)

// db — общий пул соединений с MySQL; создаётся один раз при старте.
var db *sqlx.DB

// connectDB подключается к MySQL по переменным DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME.
// ParseTime нужен, чтобы TIMESTAMP читался в time.Time.
func connectDB() (*sqlx.DB, error) {
	cfg := mysql.NewConfig()
	cfg.User = os.Getenv("DB_USER")
	cfg.Passwd = os.Getenv("DB_PASSWORD")
	cfg.Net = "tcp"
	cfg.Addr = env("DB_HOST", "localhost") + ":" + env("DB_PORT", "3306")
	cfg.DBName = env("DB_NAME", "kkmt")
	cfg.ParseTime = true
	cfg.Loc = time.Local

	conn, err := sqlx.Connect("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, err
	}
	conn.SetMaxOpenConns(10)
	conn.SetConnMaxLifetime(5 * time.Minute)
	return conn, nil
}

// schema — таблицы. Выполняется при каждом старте, поэтому везде IF NOT EXISTS.
var schema = []string{
	`CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tg_id BIGINT NOT NULL UNIQUE,
        username VARCHAR(64) NULL,
        first_name VARCHAR(128) NOT NULL DEFAULT '',
        last_name VARCHAR(128) NULL,
        photo_url VARCHAR(512) NULL,
        display_name VARCHAR(64) NULL,
        real_name VARCHAR(64) NULL,
        bio VARCHAR(500) NOT NULL DEFAULT '',
        role ENUM('student','admin','owner','moderator') NOT NULL DEFAULT 'student',
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
        kind VARCHAR(30) NOT NULL DEFAULT '',
        remote TINYINT(1) NOT NULL DEFAULT 0
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
	`CREATE TABLE IF NOT EXISTS homework_links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        date DATE NOT NULL,
        pair_no TINYINT NOT NULL,
        url VARCHAR(1000) NOT NULL,
        title VARCHAR(200) NOT NULL DEFAULT '',
        created_by INT NULL,
        INDEX idx_slot (date, pair_no),
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4`,
	// Общие материалы; описание, файлы и ссылки лежат в слоте ДЗ с датой 1000-01-01 + id дней (см. generalDate)
	`CREATE TABLE IF NOT EXISTS materials (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        created_by INT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4`,
	// Контакты преподавателей; name — как в lessons.teacher
	`CREATE TABLE IF NOT EXISTS teachers (
        name VARCHAR(200) PRIMARY KEY,
        phone VARCHAR(30) NOT NULL DEFAULT '',
        email VARCHAR(100) NOT NULL DEFAULT ''
    ) CHARACTER SET utf8mb4`,
	// Замены пар на конкретную дату (правка «только этой недели»); пустой subject — пары нет
	`CREATE TABLE IF NOT EXISTS lesson_changes (
        date DATE NOT NULL,
        pair_no TINYINT NOT NULL,
        subject VARCHAR(200) NOT NULL DEFAULT '',
        teacher VARCHAR(200) NOT NULL DEFAULT '',
        room VARCHAR(50) NOT NULL DEFAULT '',
        kind VARCHAR(30) NOT NULL DEFAULT '',
        remote TINYINT(1) NOT NULL DEFAULT 0,
        PRIMARY KEY (date, pair_no)
    ) CHARACTER SET utf8mb4`,
	`CREATE TABLE IF NOT EXISTS settings (
        k VARCHAR(50) PRIMARY KEY,
        v VARCHAR(500) NOT NULL
    ) CHARACTER SET utf8mb4`,
}

// defaultTimes — звонки по умолчанию, если таблица pair_times пустая.
var defaultTimes = [][2]string{{"08:30", "10:05"}, {"10:15", "11:50"}, {"12:20", "13:55"}, {"14:05", "15:40"}, {"15:50", "17:25"}, {"17:35", "19:10"}}

// migrate создаёт таблицы и догоняет схему до актуальной: добавляет поздние колонки,
// убирает ненужные таблицы и заполняет время пар и начало семестра.
func migrate(conn *sqlx.DB) error {
	for _, q := range schema {
		if _, err := conn.Exec(q); err != nil {
			return err
		}
	}
	// колонки, добавленные позже: на уже созданных таблицах (MySQL без ADD COLUMN IF NOT EXISTS)
	addColumn := func(table, column, ddl string) (bool, error) {
		var n int
		err := conn.Get(&n, `SELECT COUNT(*) FROM information_schema.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, table, column)
		if err != nil || n > 0 {
			return false, err
		}
		_, err = conn.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, ddl))
		return err == nil, err
	}
	if _, err := addColumn("invites", "max_uses", "INT NOT NULL DEFAULT 1"); err != nil {
		return err
	}
	added, err := addColumn("invites", "used_count", "INT NOT NULL DEFAULT 0")
	if err != nil {
		return err
	}
	if added {
		if _, err := conn.Exec("UPDATE invites SET used_count = 1 WHERE used_by IS NOT NULL"); err != nil {
			return err
		}
	}
	if _, err := addColumn("users", "invite_code", "CHAR(6) NULL"); err != nil {
		return err
	}
	if _, err := addColumn("users", "real_name", "VARCHAR(64) NULL"); err != nil {
		return err
	}
	// что именно сделать в прикреплённом файле
	if _, err := addColumn("homework_files", "note", "VARCHAR(500) NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	// пара дистанционно: и в постоянном расписании, и в заменах
	for _, t := range []string{"lessons", "lesson_changes"} {
		if _, err := addColumn(t, "remote", "TINYINT(1) NOT NULL DEFAULT 0"); err != nil {
			return err
		}
	}
	// роль moderator добавлена позже; новое значение в конце ENUM — ALTER без перестройки таблицы
	if _, err := conn.Exec("ALTER TABLE users MODIFY role ENUM('student','admin','owner','moderator') NOT NULL DEFAULT 'student'"); err != nil {
		return err
	}
	// лента без лайков и комментариев: убираем их таблицы, если остались от прежних версий
	for _, t := range []string{"comments", "post_likes"} {
		if _, err := conn.Exec("DROP TABLE IF EXISTS " + t); err != nil {
			return err
		}
	}
	var cnt int
	if err := conn.Get(&cnt, "SELECT COUNT(*) FROM pair_times"); err != nil {
		return err
	}
	if cnt == 0 {
		for i, t := range defaultTimes {
			if _, err := conn.Exec("INSERT INTO pair_times (pair_no, start_time, end_time) VALUES (?, ?, ?)", i+1, t[0], t[1]); err != nil {
				return err
			}
		}
	}
	if _, err = conn.Exec("INSERT IGNORE INTO settings (k, v) VALUES ('semester_start', ?)", time.Now().UTC().Format("2006-01-02")); err != nil {
		return err
	}
	// ключ подписи nonce хранится в базе: после перезапуска (деплоя) уже открытые страницы входа остаются рабочими
	key := make([]byte, 32)
	rand.Read(key)
	if _, err = conn.Exec("INSERT IGNORE INTO settings (k, v) VALUES ('nonce_key', ?)", hex.EncodeToString(key)); err != nil {
		return err
	}
	var stored string
	if err = conn.Get(&stored, "SELECT v FROM settings WHERE k = 'nonce_key'"); err != nil {
		return err
	}
	nonceKey, err = hex.DecodeString(stored)
	return err
}
