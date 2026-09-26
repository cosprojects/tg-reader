# telegram-reader

PoC приложения, которое превращает текстовый пост из Telegram в аудио.

Текущий этап — технический PoC. Проверяем главный вопрос: продолжает ли воспроизводиться аудио, когда Telegram Mini App свёрнут. Текст поста теперь настоящий (приходит из API бота) и озвучивается реальным TTS. Базы данных, авторизации и чтения каналов в PoC нет.

## Структура

```
telegram-reader/
├── docs/       # проектная документация
├── app/        # Mini App (React + Vite): текст поста, плеер и диагностика
├── server/     # Telegram-бот (Node.js + grammY), HTTP API и TTS
├── .env        # токен бота, ключ TTS и адреса (в Git не попадает)
└── .env.example
```

## ⚠️ Куда вставить секреты (BOT_TOKEN и TTS_API_KEY)

**Оба секрета вставляются в один файл: `telegram-reader/.env`.**

1. Откройте файл **`telegram-reader/.env`** — он лежит в корне проекта, рядом с `package.json`.
2. Там есть строка:

   ```dotenv
   BOT_TOKEN=PASTE_YOUR_BOT_TOKEN_HERE
   ```

3. Замените `PASTE_YOUR_BOT_TOKEN_HERE` на токен вашего бота целиком, без кавычек и пробелов. Должно получиться так:

   ```dotenv
   BOT_TOKEN=123456789:AAH...ваш_токен.../xYz
   ```

4. Сохраните файл и перезапустите бота (`npm run bot`).

Где взять токен: в Telegram откройте **@BotFather** → `/newbot` → задайте имя и username → BotFather пришлёт токен одной строкой. Если бот уже создан: `/mybots` → выберите бота → **API Token**.

### Ключ TTS

**Сейчас не нужен.** Провайдер синтеза не подключён (`TTS_PROVIDER=none`): endpoint
`POST /api/posts/:id/audio` отвечает заглушкой `{"status":"not_implemented"}`, Mini App показывает
«Аудио не подключено», а Play остаётся неактивным. Ключи не запрашиваются и не требуются.

Когда провайдер понадобится, в тот же `.env` добавляется ключ и меняется одна переменная:

```dotenv
TTS_PROVIDER=openai    # или macos-say — локальный синтез без ключа
TTS_API_KEY=
TTS_VOICE=alloy
```

Ключ читается только сервером и во фронтенд не попадает. Подробности, стоимость и ограничения —
в [docs/tts.md](docs/tts.md).

Что важно знать:

- **Не присылайте токен в чат** и не вставляйте его в код, в issue или в переписку — он не нужен никому, кроме этого файла.
- Файл `.env` уже в `.gitignore`, в Git он не попадёт. Шаблон без значений — `.env.example`.
- Сервер печатает только «BOT_TOKEN найден» / «TTS_API_KEY найден», а не сами значения, и вырезает их из текстов ошибок.
- Проверка, что секреты не попали во фронтенд, — в [docs/poc.md](docs/poc.md), раздел 13.

## Команды

```bash
npm install      # один раз: ставит зависимости app и server (npm workspaces)
npm run bot      # запускает Telegram-бота и локальный HTTP API
npm run dev      # запускает Mini App в режиме разработки (http://localhost:5173)
npm run build    # собирает Mini App в app/dist
npm run preview  # локально отдаёт собранную Mini App
```

Одновременный запуск бота и фронтенда — двумя терминалами (`npm run bot` и `npm run dev`). Если хочется одной командой, понадобится пакет `concurrently`; в PoC он намеренно не добавлен, чтобы не тянуть лишнюю зависимость.

Кнопка «🎧 Слушать» открывает Mini App только по **HTTPS**-адресу. Локальный `localhost` для этого не подходит — нужен туннель или деплой статики: см. [docs/poc.md](docs/poc.md), раздел 7. Адрес backend Mini App берёт из `PUBLIC_API_BASE` при сборке: `PUBLIC_API_BASE=https://ваш-api-туннель.example npm run build`.

## Документация

- [docs/poc.md](docs/poc.md) — как устроен PoC, как запустить, как провести тест, ограничения
- [docs/tts.md](docs/tts.md) — TTS: провайдер, стоимость, ограничения, замена провайдера
- [docs/product.md](docs/product.md) — продукт и его ценность
- [docs/requirements.md](docs/requirements.md) — требования
- [docs/scenarios.md](docs/scenarios.md) — пользовательские сценарии
- [docs/architecture.md](docs/architecture.md) — архитектура
- [docs/security.md](docs/security.md) — безопасность
- [docs/telegram-api-research.md](docs/telegram-api-research.md) — исследование Telegram API
