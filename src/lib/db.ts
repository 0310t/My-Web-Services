import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = process.env.SQLITE_PATH || path.join(dataDir, "history.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
  `);
  return db;
}

export interface Generation {
  id: number;
  input: string;
  output: string;
  created_at: number;
}

export function saveGeneration(input: string, output: string): number {
  const stmt = getDb().prepare("INSERT INTO generations (input, output) VALUES (?, ?)");
  const result = stmt.run(input, output);
  return Number(result.lastInsertRowid);
}

export function listGenerations(limit = 20): Generation[] {
  const stmt = getDb().prepare(
    "SELECT id, input, output, created_at FROM generations ORDER BY created_at DESC LIMIT ?",
  );
  return stmt.all(limit) as Generation[];
}

export function getGeneration(id: number): Generation | undefined {
  const stmt = getDb().prepare(
    "SELECT id, input, output, created_at FROM generations WHERE id = ?",
  );
  return stmt.get(id) as Generation | undefined;
}
