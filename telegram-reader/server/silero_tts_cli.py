#!/usr/bin/env python3
"""Синтез речи Silero для Telegram Reader.

Запускается из Node как отдельный процесс (по образцу провайдера piper):
  <venv>/bin/python3 silero_tts_cli.py --list-voices --model v5_5_ru
  <venv>/bin/python3 silero_tts_cli.py --model v5_5_ru --voice aidar \
      --text "..." --out chunk.wav

Модель и голоса берутся из пакета silero, названия не задаются вручную.
"""
import argparse
import json
import os
import sys
import time
import wave

# Python из python.org не видит системные корневые сертификаты, а silero при первом
# запуске скачивает models.yml и модель. certifi лежит в том же venv.
try:
    import certifi

    os.environ.setdefault('SSL_CERT_FILE', certifi.where())
except ImportError:
    pass

DEFAULT_MODEL = 'v5_5_ru'
DEFAULT_SAMPLE_RATE = 48000


def build_parser():
    parser = argparse.ArgumentParser(description='Silero TTS: синтез WAV из текста')
    parser.add_argument('--model', default=DEFAULT_MODEL, help='идентификатор модели, например v5_5_ru')
    parser.add_argument('--voice', help='голос внутри модели, например aidar')
    parser.add_argument('--text', help='текст для синтеза')
    parser.add_argument('--ssml-text', help='текст в формате SSML (паузы через тег break)')
    parser.add_argument('--out', help='куда записать WAV')
    parser.add_argument('--sample-rate', type=int, default=DEFAULT_SAMPLE_RATE)
    parser.add_argument('--list-voices', action='store_true', help='напечатать голоса модели в JSON')
    return parser


def load_model(model_id):
    import torch
    from silero import silero_tts

    # CPU-инференс: 4 потока — разумный компромисс для VPS без GPU.
    torch.set_num_threads(int(os.environ.get('SILERO_THREADS', '4')))

    started = time.time()
    model, _ = silero_tts(language='ru', speaker=model_id)
    model.to(torch.device('cpu'))
    return model, time.time() - started


def describe_voice_metadata(model):
    """Что модель сама сообщает о голосах: только факты, без догадок."""
    meta = {}
    for attr in ('speakers', 'speaker_genders', 'speaker_languages', 'language', 'sample_rate'):
        value = getattr(model, attr, None)
        if value is None:
            continue
        try:
            meta[attr] = list(value) if not isinstance(value, (str, int, float)) else value
        except TypeError:
            meta[attr] = str(value)
    return meta


def write_wav(path, audio, sample_rate):
    import numpy as np

    data = audio.detach().cpu().numpy() if hasattr(audio, 'detach') else np.asarray(audio)
    pcm = np.clip(data, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype('<i2')
    with wave.open(path, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())
    return len(pcm)


def main():
    args = build_parser().parse_args()
    model, load_seconds = load_model(args.model)

    if args.list_voices:
        print(json.dumps({
            'model': args.model,
            'loadSeconds': round(load_seconds, 2),
            'metadata': describe_voice_metadata(model),
        }, ensure_ascii=False))
        return 0

    if not args.voice or not args.out or not (args.text or args.ssml_text):
        print('нужны --voice, --out и один из --text / --ssml-text', file=sys.stderr)
        return 2

    started = time.time()
    # Silero принимает SSML отдельным аргументом, а не как обычный текст.
    if args.ssml_text:
        audio = model.apply_tts(ssml_text=args.ssml_text, speaker=args.voice, sample_rate=args.sample_rate)
    else:
        audio = model.apply_tts(text=args.text, speaker=args.voice, sample_rate=args.sample_rate)
    synth_seconds = time.time() - started

    samples = write_wav(args.out, audio, args.sample_rate)
    print(json.dumps({
        'model': args.model,
        'voice': args.voice,
        'ssml': bool(args.ssml_text),
        'sampleRate': args.sample_rate,
        'samples': samples,
        'seconds': round(samples / args.sample_rate, 3),
        'loadSeconds': round(load_seconds, 2),
        'synthSeconds': round(synth_seconds, 2),
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
