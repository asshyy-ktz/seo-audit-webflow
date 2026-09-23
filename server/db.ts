import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "..", "db", "seo-audit.sqlite");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const SCHEMA_PATH = path.join(__dirname, "..", "db", "schema.sql");

export function migrate(): void {
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));
}
