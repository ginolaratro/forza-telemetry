import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.FORZA_DATA_DIR ?? path.join(ROOT, "data");
export const RAW_DIR = path.join(DATA_DIR, "raw");
export const DB_PATH = process.env.FORZA_DB ?? path.join(DATA_DIR, "forza.db");
export const PORT = Number(process.env.FORZA_PORT ?? 5344);
export const HOST = process.env.FORZA_HOST ?? "0.0.0.0";
