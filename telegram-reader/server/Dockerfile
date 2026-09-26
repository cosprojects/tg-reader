# Backend Telegram Reader: Node (бот и HTTP API) + Python с torch для Silero + ffmpeg.
# Контекст сборки — каталог telegram-reader/: оттуда берутся корневой package.json и lockfile.
FROM node:22-bookworm-slim

# ffmpeg превращает WAV в m4a (см. COMPRESSORS в server/src/tts.js).
# ca-certificates нужны пакету silero: он скачивает модель при первом запуске.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# venv с torch отдельным слоем: правки кода не тянут зависимости заново.
# torch берётся с CPU-индекса — версия с PyPI везёт CUDA и весит в разы больше.
ARG SILERO_VENV=/opt/silero-venv
RUN python3 -m venv "$SILERO_VENV" \
 && "$SILERO_VENV/bin/pip" install --no-cache-dir --upgrade pip \
 && "$SILERO_VENV/bin/pip" install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && "$SILERO_VENV/bin/pip" install --no-cache-dir silero certifi

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY app/package.json app/
RUN npm ci --omit=dev --workspace server

COPY server ./server

# Модель (~100 МБ) забираем на сборке: иначе она скачивается при первом синтезе на каждой машине.
RUN "$SILERO_VENV/bin/python" server/silero_tts_cli.py --list-voices --model v5_5_ru > /dev/null

ENV TTS_SILERO_PYTHON=/opt/silero-venv/bin/python3 \
    TTS_AUDIO_COMPRESSOR=ffmpeg \
    TTS_SILERO_DATA_DIR=/data/silero \
    AUDIO_CACHE_DIR=/data/audio \
    SILERO_THREADS=2 \
    API_PORT=3001
EXPOSE 3001
CMD ["node", "server/src/index.js"]
