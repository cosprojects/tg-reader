// Единственный путь «пост → готовое аудио в кэше». Им пользуются и бот (готовит аудио
// сразу после получения поста), и Mini App (POST /api/posts/:id/audio). Ключ кэша —
// пост + провайдер + голос, поэтому один и тот же пост синтезируется ровно один раз,
// кто бы ни запросил его первым: бот и Mini App получают тот же результат.
import { generateOnce, readManifest, saveAudio } from './audio-store.js';
import { synthesize } from './tts.js';

export function audioKey(postId, provider, voice) {
  return `${postId}:${provider}:${voice}`;
}

// signal прерывает синтез: процесс провайдера получает SIGTERM, в кэш ничего не пишется.
// onProgress сообщает номер части до её синтеза — по нему обновляется сообщение в Telegram.
export async function generateAudioForPost(config, post, { provider, voice, signal, onProgress } = {}) {
  const cached = await readManifest(post.id, provider, voice);
  if (cached) return { manifest: cached, cached: true };

  return generateOnce(audioKey(post.id, provider, voice), async () => {
    const raced = await readManifest(post.id, provider, voice);
    if (raced) return { manifest: raced, cached: true };

    const results = await synthesize(config, post.text, { provider, voice, signal, onProgress });
    return { manifest: await saveAudio(post.id, provider, voice, results), cached: false };
  });
}
