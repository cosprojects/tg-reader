# Исследование Telegram API

**Статус:** исследование в процессе. Не завершено.
**Дата проверки источников:** 24.09.2026
**Проверенная версия Bot API:** 10.3 (запись в changelog от 24.08.2026)
**Область документа:** только ответ на вопрос о доступе к контенту каналов и о юридических рамках. Архитектура реализации здесь не описывается и не должна описываться, пока исследование не завершено.

---

## 0. Соглашения

- **[TBD — needs verification]** — утверждение, которое не подтверждено документацией Telegram или не проверено на практике. Такие утверждения запрещено использовать как основание для проектных решений.
- **Подтверждено** — утверждение, которое прямо присутствует в официальной документации, со ссылкой и цитатой.
- Все цитаты приведены на языке источника (английский), чтобы их можно было проверить дословно.

---

## 1. Главный вывод (предварительный)

Целевая цепочка продукта:

```
Mini App → пользователь сам выбирает канал через Telegram UI → приложение получает reference
→ backend получает доступ только к этому каналу → backend получает посты → текст → audio
```

Разбор по шагам:

| Шаг | Вердикт | Основание |
| --- | --- | --- |
| Mini App открывается в Telegram | Подтверждено | Mini Apps — штатный механизм |
| Пользователь выбирает канал через нативный UI Telegram | Подтверждено | `KeyboardButtonRequestChat`, `savePreparedKeyboardButton`, `WebApp.requestChat` |
| Приложение получает reference канала (id, title, username) | Подтверждено | сервисное сообщение `chat_shared` |
| Backend получает доступ к контенту только этого канала | **Не подтверждено, и документация предупреждает об обратном** | см. §3.4 |
| Backend получает посты канала | **Не подтверждено. В Bot API нет метода для чтения истории канала** | см. §3.1, §3.2 |
| Текст → audio | Зависит от технического решения, ограничено юридически | см. §5 |

**Ключевой риск:** первые три шага (выбор канала и получение reference) в Bot API реализуются штатно. Критический шаг — получение постов — в Bot API не обеспечен: метод чтения истории канала отсутствует, а бот получает посты канала только если является участником этого канала. При этом документация Telegram прямо предупреждает, что полученный reference не даёт боту доступа к каналу.

Как следствие: **модель «только Bot API, без пользовательской MTProto-сессии» на текущем уровне знаний не покрывает основной сценарий продукта** (пользователь слушает каналы, в которых он не администратор). Это предварительный вывод; он должен быть подтверждён или опровергнут spike-проверкой (§7).

---

## 2. Методология

Что реально проверено:

1. Полный список методов Bot API 10.3 выгружен и перебран вручную — поиск любого метода чтения истории сообщений.
2. Прочитаны разделы Bot API о `KeyboardButtonRequestChat`, `ChatShared`, `savePreparedKeyboardButton`, `getChat`, `getUserPersonalChatMessages`, обновлениях `channel_post` и `guest_message`.
3. Прочитана документация Mini Apps: `WebAppInitData`, `WebApp.requestChat`, требования к валидации данных.
4. Прочитаны страницы «Bots: Features» (Chat and User Selection, Privacy Mode, Guest Bots) и «Bot FAQ» (What messages will my bot get?).
5. Прочитаны `messages.getHistory` и обзор `api/channel` из MTProto-документации.
6. Прочитаны юридические документы: Telegram API ToS, Terms of Service for Content Licensing, Telegram Bot Platform Developer Terms of Service, страница получения `api_id`, Privacy Policy §6.3.

Чего в проверке нет: живых экспериментов с реальным ботом и реальным каналом. Ни один шаг не проверен на практике — это и есть предмет §7.

---

## 3. Подтверждённые факты

### 3.1. В Bot API нет метода для чтения истории канала

Полный список методов Bot API 10.3 перебран. Методов чтения сообщений по идентификатору чата нет: отсутствуют `getMessages`, `getChatHistory`, `getChannelPosts` и любые аналоги. Доступные методы работы с чатами ограничены метаданными: `getChat`, `getChatAdministrators`, `getChatMember`, `getChatMemberCount`, `getChatMenuButton`.

Практическое следствие: единственный способ для бота получить текст поста канала — получить его в виде обновления (`channel_post`). Бот не может «попросить» историю постов.

> Отдельно: в списке методов присутствует `getUserPersonalChatMessages` — «Use this method to get the last messages from the personal chat (i.e., the chat currently added to their profile) of a given user». Для нашего продукта этот метод должен быть прямо запрещён к использованию (см. `security.md`, BAN-03). Условия, при которых он доступен, не проверялись. **[TBD — needs verification]**

### 3.2. Бот получает посты канала только как участник канала

Bot FAQ, раздел «What messages will my bot get?»:

> 1. All bots, regardless of settings, will receive:
> - All service messages.
> - All messages from private chats with users.
> - **All messages from channels where they are a member.**

То же утверждение повторено в «Bots: Features» → «Privacy Mode» → «All bots will also receive, regardless of privacy mode: ... All messages from channels where they are a member.»

Формулировка «where they are a member» означает, что бот не получает посты произвольных каналов, а только тех, где он состоит. Как именно бот становится участником канала и может ли он быть участником-неадминистратором — в документации не сказано. **[TBD — needs verification]**

### 3.3. Штатный механизм выбора канала пользователем существует

Три документально описанных элемента складываются в нужную последовательность:

1. **`KeyboardButtonRequestChat`** — кнопка, по нажатию которой открывается список подходящих чатов; выбранный чат отправляется боту сервисным сообщением `chat_shared`. Поля: `chat_is_channel`, `chat_is_forum`, `chat_has_username`, `chat_is_created`, `user_administrator_rights`, `bot_administrator_rights`, `bot_is_member`, `request_title`, `request_username`, `request_photo`. Доступно только в приватных чатах.
2. **`savePreparedKeyboardButton`** — «Stores a keyboard button that can be used by a user within a Mini App. Returns a PreparedKeyboardButton object.» Параметр `button` должен быть типа `request_users`, `request_chat` или `request_managed_bot`. Это то, что позволяет вызвать нативный выбор чата **изнутри Mini App**, а не из клавиатуры в чате с ботом.
3. **`WebApp.requestChat(req_id)`** (Bot API 9.6+) — «A method that opens a dialog allowing the user to select an existing chat or create a new one. The request id passed to this method must belong to a PreparedKeyboardButton previously obtained via the Bot API method savePreparedKeyboardButton.»

Документация «Bots: Features» описывает этот механизм как штатный:

> Bots can present the user with a friendly and intuitive interface that lists any number of groups, channels or other users according to a custom set of criteria. Tapping on a chat will send its identifier to the bot in a service message and seamlessly close the interface.

**Вывод:** требование «Reader НЕ должен автоматически сканировать список каналов пользователя, пользователь сам выбирает канал» технически поддерживается платформой. Это не обходной путь, а предусмотренный механизм.

### 3.4. Reference канала не даёт доступа к контенту — это прямо задокументировано

Это центральный факт исследования. Два независимых места в документации:

`ChatShared.chat_id`:

> Identifier of the shared chat. ... **The bot may not have access to the chat and could be unable to use this identifier, unless the chat is already known to the bot by some other means.**

«Bots: Features» → «Chat and User Selection»:

> Keep in mind that the bot may not be able to use the identifier it receives if the corresponding chat or user is not already known or accessible by some other means.

Формулировка «unless the chat is already known to the bot by some other means» важна: если бот уже состоит в канале (то есть получает `channel_post`), reference пригодится. Если не состоит — идентификатор не даёт ничего, кроме самого идентификатора.

### 3.5. Guest Mode не решает задачу

Bot API 10.0 добавил Guest Mode: «allowing bots to receive certain messages and issue replies within chats they are not a member of». Документация «Bots: Features» → «Guest Bots» уточняет область применения и прямо ограничивает её:

> Telegram bots can enable Guest Mode to easily interact with users in **any group or private chat** on Telegram.
> Guest mode **does not grant access to a chat's message history or participant list.**

Каналы в области применения не названы; доступ к истории исключён явно. Guest Mode не является путём к контенту каналов.

### 3.6. Mini App не получает список чатов пользователя

`WebAppInitData` содержит ограниченный набор полей: `query_id`, `chat_join_request_query_id`, `user`, `receiver`, `chat`, `chat_type`, `chat_instance`, `start_param`, `can_send_after`, `auth_date`, `hash`, `signature`.

- Поля `chat` и `receiver` возвращаются только для Mini Apps, запущенных через attachment menu, и для запросов на вступление.
- `chat_type` и `chat_instance` — только при запуске по прямой ссылке (значение `channel` возможно).
- Списка чатов пользователя в initData нет.

Это подтверждает, что требование «не получать список каналов пользователя» соответствует фактическим возможностям платформы: платформа такого списка и не отдаёт.

> `initData` содержит `hash` и `signature`. Документация требует: «WARNING: Data from this field should not be trusted. You should only use data from initData on the bot's server and only after it has been validated.» Требование к валидации — в `security.md`.

### 3.7. MTProto (user session) — теоретически покрывает задачу, детали не проверены

`messages.getHistory` — «Returns the message history in a peer. Results are ordered by date (descending).» Параметры включают `peer:InputPeer`, `offset_id`, `offset_date`, `add_offset`, `limit`, `max_id`, `min_id`. Для работы нужен авторизованный аккаунт, то есть пользовательская сессия MTProto.

Что это означает: технически пользовательская сессия даёт доступ к тем же чатам, что и официальный клиент, включая каналы, на которые пользователь подписан. Готовность этого пути для нашего сценария (чтение каналов, включая публичные, на которые пользователь не подписан; поведение read state; лимиты) не проверена. **[TBD — needs verification]**

### 3.8. Что Bot/Privacy Policy говорит о данных, которые получает бот

Telegram Privacy Policy, §6.3 «What Data Bots Receive»: публичные данные аккаунта (экранное имя, username, фото профиля); сообщения, которые пользователь отправляет боту; при наличии доступа — сообщения групп. Отдельно §6.5 описывает Telegram Business: подключённый бот получает доступ ко всем сообщениям, медиа и файлам в тех приватных чатах, которыми ему разрешено управлять, и может отправлять сообщения от имени владельца аккаунта.

Следствие для продукта: Telegram Business — механизм с избыточными правами для нашей задачи; его использование должно быть запрещено на уровне продукта (см. BAN-11).

---

## 4. Целевая цепочка: детальный разбор

### 4.1. Что работает без оговорок

1. Mini App запускается в Telegram.
2. Backend вызывает `savePreparedKeyboardButton` с кнопкой типа `request_chat` и получает `PreparedKeyboardButton`.
3. Mini App вызывает `WebApp.requestChat(req_id)`.
4. Пользователь выбирает канал в нативном интерфейсе Telegram.
5. Бот получает сервисное сообщение `chat_shared` с `chat_id`, а при запросе — `title`, `username`, `photo`.
6. Backend сохраняет канал в список каналов пользователя — как **заявку на добавление**, а не как источник контента.

Шаги 1–6 подтверждены документацией.

### 4.2. Где цепочка обрывается

7. Backend пытается получить посты. Метода чтения истории в Bot API нет (§3.1).
8. Обновления `channel_post` приходят только для каналов, где бот — участник (§3.2). Для произвольного канала, выбранного пользователем, это условие не выполняется.
9. Документация прямо предупреждает, что `chat_id` из `chat_shared` может быть бесполезен (§3.4).

### 4.3. Возможные пути обхода и их статус

| Путь | Описание | Статус |
| --- | --- | --- |
| Назначить бота администратором канала | Пользователь добавляет бота в канал с правами администратора | Работает по документации, но требует прав администратора канала. Для чужих каналов недоступно |
| Guest Mode | Получать контент в чатах без членства | Не покрывает каналы и прямо не даёт историю (§3.5) |
| Пользовательская MTProto-сессия | Пользователь авторизует наш сервис своим аккаунтом | Технически вероятно, требует проверки; высокие требования к безопасности и юридические риски (§5) |
| Пересылка поста боту | Пользователь сам пересылает/отправляет пост боту, бот получает текст | Соответствует определению данных, «submitted directly and voluntarily to your TPA by users» (Bot Developer Terms §4.3) |
| Скрейпинг веб-превью `t.me/s/<channel>` | Чтение HTML-страницы публичного превью канала | Не документировано как API; прямо противоречит запрету на scraping (Content Licensing ToS) **[TBD — needs verification]** |
| Сервисный аккаунт, подписанный на публичные каналы | Наш собственный аккаунт читает публичные каналы и раздаёт контент | Прямо запрещено: Bot Developer Terms §4.3 называет это в числе запрещённых сценариев |

Последние две строки — не «варианты», а перечень запрещённых путей. Они приведены, чтобы исключить их обсуждение на этапе проектирования.

---

## 5. Юридические ограничения

Это не юридическая консультация. Ниже — дословные цитаты из действующих документов Telegram, которые напрямую ограничивают продукт. По каждому пункту нужна проверка юристом. **[TBD — needs verification]**

### 5.1. Конвертация в аудио и запрет на использование данных для AI/ML

Telegram API ToS, п. 1.5:

> Your use of the Telegram API is further subject to the Telegram Terms of Service for Content Licensing and AI Scraping. As such, you are prohibited from using, accessing or aggregating data obtained from the Telegram platform to train, fine-tune or otherwise engage in the development, enhancement or deployment of artificial intelligence, machine learning models and similar technologies.

Terms of Service for Content Licensing:

> For clarity, Telegram firmly prohibits the scraping, indexing, harvesting, aggregation or use of data obtained from its platform to train, fine-tune, validate or otherwise engage in the development, enhancement, benchmarking or deployment of artificial intelligence, machine learning models and similar technologies.
> Exceptions may be granted in instances where all relevant users individually provide explicit, informed, affirmative and continued consent that is strictly limited to the specific content and chat, channel, or non-global context window for which it was requested.

**Почему это важно именно для нас:** синтез речи выполняется ML-моделью. Передача текста поста в TTS-движок — это «use of data obtained from its platform» в контексте «deployment of ... machine learning models». Трактовка спорная, но риск реален: продукт, чья суть — прогон текста постов через ML-модель, может быть квалифицирован как нарушение.

Возможные направления снижения риска (требуют юридической проверки, не решения):

- синтез только по запросу конкретного пользователя, для этого пользователя, без накопления контента;
- отсутствие индекса, поиска и любых агрегатов по контенту Telegram;
- отсутствие обучения и дообучения на контенте;
- TTS-провайдер с договорным запретом на хранение и обучение, либо синтез на устройстве пользователя без передачи текста третьим лицам;
- явное согласие пользователя с описанием обработки.

### 5.2. Запрет на сбор и хранение сверх необходимого

Telegram Bot Platform Developer Terms of Service, §4.3 «Data Scraping»:

> You agree not to use your TPA to collect, store, aggregate or process data beyond what is essential for the operation of your services. Always prohibited uses include any form of data collection aimed at creating large datasets, machine learning models and AI products, such as scraping public group or channel contents.

Следствие для проектирования: хранение текстов постов, кэширование контента каналов, построение индекса — риск нарушения, а не оптимизация.

### 5.3. Обработка «read status»

Telegram API ToS, п. 1.4:

> It is forbidden to interfere with the basic functionality of Telegram. This includes but is not limited to: making actions on behalf of the user without the user's knowledge and consent, ... tampering with the 'read' statuses of messages (e.g. implementing a 'ghost mode') ...

Требование брифа «Reader НЕ должен изменять read status Telegram» совпадает с запретом на вмешательство. Одновременно возникает вопрос: чтение канала через пользовательскую сессию без отметки о прочтении — это и есть поведение, которое в документе названо «ghost mode». Формулировка допускает разные трактовки. **[TBD — needs verification]**

### 5.4. Обязательная поддержка спонсорских сообщений

Telegram API ToS, п. 3.3:

> If your app allows accessing content from Telegram channels, you must include support for official sponsored messages in Telegram channels and may not interfere with this functionality.

Наш продукт по определению даёт доступ к контенту каналов. Это требование нужно учесть в продуктовой модели, включая монетизацию. Применимость к Mini App (в отличие от стороннего клиента) не проверена. **[TBD — needs verification]**

### 5.5. Именование

Telegram API ToS, п. 2.3: название приложения не должно включать слово «Telegram», кроме случая, когда ему предшествует слово «Unofficial». Имя проекта «Telegram Reader» этому требованию не соответствует. Требуется решение о названии. **[TBD — needs verification]**

### 5.6. Хранение и удаление данных

Bot Developer Terms §4.2 требует удалять пользовательские данные: по запросу пользователя, когда необходимость отпала, при прекращении работы TPA, по законному требованию. §4.4(a) — обязательное шифрование данных at rest с хранением ключа отдельно от данных. §4.5 — `api_id`, `api_hash` и токены не могут быть публичными, и «any actions taken by others who authenticate using your credentials will be deemed as taken by you».

### 5.7. Риск бана аккаунта при использовании user-сессии

Страница получения `api_id`:

> If you use the Telegram API for flooding, spamming, faking subscriber and view counters of channels, you will be banned forever.
> Due to excessive abuse of the Telegram API, all accounts that log in using unofficial Telegram API clients are automatically put under observation to avoid violations of the Terms of Service.

Практический смысл: любая модель с пользовательской MTProto-сессией несёт риск блокировки аккаунта пользователя, и этот риск нельзя полностью снять на нашей стороне.

---

## 6. Варианты модели доступа к контенту

Оценка выполнимости, без выбора реализации.

### Вариант A. Только Bot API, бот — администратор канала

Пользователь добавляет нашего бота администратором в канал, после чего бот получает `channel_post` и текст постов.

- Плюсы: полностью в рамках задокументированных возможностей; нет пользовательских сессий и связанных рисков.
- Минусы: требует прав администратора в канале. Для каналов, которые пользователь просто читает, недоступно. Основной сценарий продукта не покрывается.
- Вердикт: **подходит только для узкого класса каналов, которыми пользователь владеет или управляет.**

### Вариант B. Bot API + пользовательская MTProto-сессия

Bot API используется для интерфейса Mini App; контент читается от имени пользователя через MTProto.

- Плюсы: покрывает основной сценарий; доступ ровно к тем каналам, которые пользователь видит сам.
- Минусы: сервис получает доступ к пользовательскому аккаунту; требуется хранение долгоживущих секретов (обязательно зашифрованных, с ключом отдельно от данных); риск бана аккаунта (§5.7); конфликт с запретом на вмешательство в read status (§5.3); существенный рост поверхности атаки и юридической ответственности; сложный онбординг (вход по номеру телефона и коду).
- Вердикт: технически наиболее вероятный путь к основному сценарию. Требует подтверждения и отдельной оценки допустимости.

### Вариант C. Продукт как сторонний Telegram-клиент

Не Mini App, а отдельное приложение-клиент на MTProto.

- Плюсы: Content Licensing ToS явно допускает «a legitimate third-party Telegram Client» как исключение.
- Минусы: другой продукт — распространение через магазины приложений, требования к полноте клиента (п. 1.3 API ToS: базовые функции Telegram должны работать корректно), существенно больший объём работ.
- Вердикт: выходит за рамки текущего брифа. Полезно держать как долгосрочную опцию.

### Вариант D. Пользователь сам передаёт пост боту

Пользователь отправляет или пересылает пост в чат с ботом; бот получает текст как сообщение.

- Плюсы: реализуется на Bot API без дополнительных разрешений; соответствует Bot Developer Terms §4.3 («data submitted directly and voluntarily to your TPA by users» — при явном информировании и согласии); отсутствуют пользовательские сессии; минимум юридических рисков; согласуется с принципом «только то, что пользователь явно предоставил».
- Минусы: не даёт «Reader сам следит за каналами»; каждый пост нужно передавать вручную; список каналов и счётчик новых постов в текущей формулировке не работают.
- Вердикт: **единственный путь, полностью укладывающийся в Bot API и минимально рискованный.** Меняет продукт, но сохраняет его суть — «текст поста становится аудио».

### Вариант E. Гибрид: D как MVP + B как расширение

MVP на варианте D; вариант B добавляется для пользователей, которые готовы авторизовать сессию, и только после подтверждения юридической допустимости.

- Вердикт: реалистичный способ начать работу до завершения исследования рисков.

---

## 7. План проверки (spike)

Цель: превратить вывод §1 из предварительного в подтверждённый. Проверка выполняется на тестовом боте и тестовом канале, без продакшн-данных.

| ID | Проверка | Что считаем результатом |
| --- | --- | --- |
| V-1 | Создать тестовый канал. Добавить бота администратором. Опубликовать пост. | Бот получил `channel_post` с текстом — подтверждает §3.2 |
| V-2 | Создать второй тестовый канал. Добавить бота **без** прав администратора (если интерфейс это позволяет). Опубликовать пост. | Определяет, может ли бот быть неадминистратором и получает ли он посты. Закрывает главный **[TBD]** из §3.2 |
| V-3 | Подписать тестовый аккаунт на чужой публичный канал. Вызвать `getChat` для этого канала от имени бота. | Показывает, работают ли метаданные без членства |
| V-4 | Вызвать `savePreparedKeyboardButton` с `chat_is_channel: true` и `WebApp.requestChat`, выбрать канал, где бот не состоит. | Проверяет §3.3 целиком: приходит ли `chat_shared`, какие поля заполнены |
| V-5 | Сразу после V-4 попытаться получить любой контент канала (`channel_post`, метаданные). | Практическое подтверждение §3.4 на живом примере |
| V-6 | Собрать Mini App, запустить, залогировать `initData`. | Подтверждает §3.6: список чатов в initData отсутствует |
| V-7 | Авторизовать тестовый аккаунт через MTProto-библиотеку, прочитать историю публичного канала, на который аккаунт не подписан. | Проверяет §3.7: доступность истории без подписки |
| V-8 | В том же MTProto-сеансе проверить, меняется ли read state канала после чтения истории. | Прямо влияет на §5.3 и на требование «не изменять read status» |
| V-9 | Проверить, помечается ли аккаунт ограничениями после серии запросов чтения. | Оценка риска §5.7 |
| V-10 | Юридическая проверка §5.1 и §5.4 профильным юристом. | Письменное заключение по трактовке TTS как ML-deployment |

Критерий завершения исследования: пункты V-1…V-10 выполнены или явно признаны невыполнимыми, вывод §1 подтверждён либо опровергнут, и в `architecture.md` можно приступать к проектированию.

---

## 8. Вопросы, требующие проверки

| ID | Вопрос | Почему важен |
| --- | --- | --- |
| RQ-1 | Может ли бот состоять в канале, не являясь администратором, и получает ли он тогда `channel_post`? | Определяет, существует ли вообще путь A и есть ли смысл в выборе канала пользователем |
| RQ-2 | Работает ли `getChat` для канала, в котором бот не состоит? | Единственный возможный источник метаданных канала (название, число постов) |
| RQ-3 | Что именно вернёт `chat_shared` при выборе канала, где бот не состоит: `chat_id`, `title`, `username`, `photo`? | От этого зависит, что можно показать в списке каналов |
| RQ-4 | Есть ли лимиты на количество `PreparedKeyboardButton` и на частоту вызовов `savePreparedKeyboardButton`? | Влияет на UX добавления канала |
| RQ-5 | Работает ли `WebApp.requestChat` при запуске Mini App из списка чатов бота, из attachment menu, из прямой ссылки? | Определяет, откуда пользователь сможет запускать приложение |
| RQ-6 | Отдаёт ли Telegram посты канала боту, если пост опубликован **до** добавления бота? | Влияет на объём доступной истории |
| RQ-7 | Существует ли в Bot API 10.3 способ получить конкретный пост канала по `message_id`, не будучи участником? | Окончательная проверка отсутствия метода чтения |
| RQ-8 | Какие условия доступа нужны для `getUserPersonalChatMessages`? | Метод даёт доступ к личным сообщениям; нужно убедиться, что наш продукт не сможет его вызвать случайно |
| RQ-9 | Даёт ли MTProto-сессия доступ к истории публичного канала без подписки на него? | Определяет объём сценария для варианта B |
| RQ-10 | Изменяет ли чтение истории через MTProto read state канала, и можно ли этого избежать? | Требование «не изменять read status» + риск по §5.3 |
| RQ-11 | Какие практические лимиты у MTProto на чтение истории и как быстро аккаунт попадает под ограничения? | Оценка эксплуатационных рисков варианта B |
| RQ-12 | Требует ли Mini App обязательной поддержки спонсорских сообщений, или требование относится только к сторонним клиентам? | Влияет на продуктовую модель и монетизацию |
| RQ-13 | Допустимо ли считать TTS-синтез «deployment of ML models» по смыслу ToS, и попадает ли продукт в исключение через согласие пользователя? | Вопрос существования продукта в текущем виде |
| RQ-14 | Требует ли вызов `WebApp.requestChat` наличия у бота каких-либо прав (`bot_is_member`, `bot_administrator_rights`)? | Влияет на дизайн запроса выбора канала |
| RQ-15 | Может ли Mini App быть добавлен в канал (attachment menu канала) и получить `chat` в initData? | Альтернативный путь получения reference канала |

---

## 9. Сделанные предположения

| ID | Предположение | Как проверяется |
| --- | --- | --- |
| AS-1 | «Текстовое содержимое» = поле `text` сообщения. Подписи к медиа (`caption`) не обрабатываются, поскольку пост с медиа не является текстовым постом | Требуется подтверждение владельцем продукта |
| AS-2 | Ссылки внутри текста не раскрываются и не разрешаются; текст либо сохраняется как есть, либо удаляется при озвучивании | Требуется решение владельца продукта |
| AS-3 | Под одним постом канала понимается одно сообщение; объединённые альбомы из нескольких сообщений не рассматриваются как один пост | Требуется решение |
| AS-4 | Озвучивание выполняется на стороне сервиса, а не на устройстве пользователя | Проверяется на этапе выбора TTS, зависит от RQ-13 |
| AS-5 | «Состояние прослушивания» и «количество новых постов» — собственное состояние Reader, не связанное с read state Telegram | Соответствует требованию брифа, подтверждения не требует |
| AS-6 | Аудитория — пользователи, которые уже читают Telegram-каналы и хотят слушать их в дороге или во время других занятий | Продуктовая гипотеза, требует валидации |
| AS-7 | Пользователь готов явно добавлять каналы, а не ожидать автоматической подписки | Продуктовая гипотеза, соответствует требованию брифа |
| AS-8 | В первом релизе достаточно одного языка синтеза — языка пользователя | Требуется решение |
| AS-9 | Один пользователь, один список каналов, без шаринга и публичных подборок | Соответствует принципу минимизации данных |

---

## 10. Влияние на остальные документы

- `product.md` — обещание «слушайте любые свои каналы» условно до завершения §7. Продуктовая модель может сузиться до варианта D.
- `requirements.md` — требования к чтению постов канала помечены как зависящие от результата исследования.
- `security.md` — запреты из §5 перенесены в жёсткие требования безопасности.
- `architecture.md` — **не заполняется** до завершения §7. Любое проектирование сейчас будет основано на непроверенных предположениях о доступе к контенту.

---

## 11. Источники

Все источники проверены 24.09.2026.

| Документ | URL |
| --- | --- |
| Telegram Bot API (v10.3) | https://core.telegram.org/bots/api |
| Telegram Mini Apps | https://core.telegram.org/bots/webapps |
| Bots: Features | https://core.telegram.org/bots/features |
| Bot FAQ | https://core.telegram.org/bots/faq |
| MTProto: messages.getHistory | https://core.telegram.org/method/messages.getHistory |
| MTProto: Channels overview | https://core.telegram.org/api/channel |
| Telegram API Terms of Service | https://core.telegram.org/api/terms |
| Creating your Telegram Application (api_id) | https://core.telegram.org/api/obtaining_api_id |
| Terms of Service for Content Licensing | https://telegram.org/tos/content-licensing |
| Telegram Bot Platform Developer Terms of Service | https://telegram.org/tos/bot-developers |
| Telegram Privacy Policy (§6.3) | https://telegram.org/privacy |
| Post Widget (шаблон встраивания постов) | https://core.telegram.org/widgets/post |

---

## Architecture Decision

**Статус: Mini App + automatic access to user's subscribed channels — BLOCKED / UNCONFIRMED.**

Причина:

- Bot API не предоставляет Mini App доступ к истории произвольных каналов пользователя.
- requestChat позволяет явно выбрать chat, но не предоставляет достаточный MTProto peer для чтения истории.
- OAuth/OIDC подтверждает identity, но не создаёт user MTProto session.
- MTProto session не имеет channel-scoped permission.
- Документированного безопасного flow Mini App → selected channel → channel-scoped MTProto access нет.

Основания внутри этого документа: §3.1 (в Bot API нет метода чтения истории), §3.2 (`channel_post` приходит только от каналов, где бот состоит участником), §3.4 (полученный `chat_id` не даёт доступа к каналу), §4.3 (перечень путей и их статус), §5 (юридические ограничения).

Один элемент остаётся недокументированным: происхождение `web_auth_token` в `auth.importWebTokenAuthorization#2db873a9 api_id:int api_hash:string web_auth_token:string = auth.Authorization`. Сам метод документирован, источник токена — нет. **[TBD — needs verification]** На вывод это не влияет: утверждение «OAuth/OIDC не создаёт user MTProto session» относится к документированному OIDC-флоу, а любой гипотетический мостик дал бы полную сессию аккаунта, а не доступ к одному каналу.

---

## Alternative Product Direction

Рассмотреть MVP:

```
Telegram post
  → explicit user share/forward
  → Reader Bot
  → Reader Mini App
  → text extraction
  → TTS
  → audio player
```

Документальное основание направления — Bot Developer Terms §4.3:

> Without limiting the foregoing, you are free to use data submitted directly and voluntarily to your TPA by users, provided that you clearly inform them of the data's intended use and they give their individual, explicit, active and revocable consent.

Это единственная из рассмотренных моделей, которая не требует ни пользовательской MTProto-сессии, ни доступа бота к каналам, где он не состоит: контент передаёт сам пользователь.

Чего направление не снимает: конвертация текста в аудио по-прежнему выполняется моделью синтеза речи, поэтому остаются вопросы по §5.1 (использование данных платформы в ML/AI-сценариях) и по условиям поставщика синтеза, описанным в `security.md` §8. **[TBD — needs verification]**

Направление не проверялось на практике: это гипотеза для следующего этапа, а не подтверждённая модель.
