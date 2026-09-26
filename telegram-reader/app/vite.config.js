import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

export default defineConfig(({ mode }) => {
  // .env лежит в корне проекта (telegram-reader/.env), рядом с .env.example.
  // PUBLIC_API_BASE — публичный адрес backend; во фронтенд попадает только он,
  // секретов (BOT_TOKEN, TTS_API_KEY) в бандле нет.
  const env = loadEnv(mode, projectRoot, '');
  const publicApiBase = (process.env.PUBLIC_API_BASE || env.PUBLIC_API_BASE || '').trim().replace(/\/+$/, '');

  if (!publicApiBase) {
    console.warn(
      '[vite] PUBLIC_API_BASE не задан: Mini App соберётся без адреса backend и покажет ошибку «API не настроен».',
    );
  }

  return {
    plugins: [react()],
    server: {
      // host: true — чтобы dev-сервер был доступен с телефона в той же сети.
      host: true,
      port: 5173,
    },
    // Адрес API подставляется в код на этапе сборки. Изменить его без пересборки нельзя.
    define: { __PUBLIC_API_BASE__: JSON.stringify(publicApiBase) },
  };
});
