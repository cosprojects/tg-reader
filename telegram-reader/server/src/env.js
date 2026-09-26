// Загрузка переменных окружения. Токен читается только здесь и только в процессе сервера.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

// Ищем .env рядом с модулем (server/.env) и в корне проекта (telegram-reader/.env).
// При запуске через npm workspaces cwd = server/, поэтому путь до корня вычисляем от модуля.
export function loadEnv() {
  for (const file of [path.resolve(here, '../.env'), path.resolve(here, '../../.env')]) {
    if (existsSync(file)) dotenv.config({ path: file, quiet: true });
  }
}
