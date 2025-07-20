const { Pool } = require('pg');
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 3000;
const url = process.env.RENDER_EXTERNAL_URL;

const token = process.env.BOT_TOKEN;
const channelId = process.env.CHANNEL_ID;

// --- Webhook or Polling ---
let bot;
if (url) {
  // Production: use webhook, но сервер Express слушает порт!
  bot = new TelegramBot(token);
  bot.setWebHook(`${url}/bot${token}`, { allowed_updates: ["message", "callback_query"] });
  console.log(`Webhook set to: ${url}/bot${token}`);
} else {
  // Local: use polling
  bot = new TelegramBot(token, { polling: true });
  console.log('Bot started in polling mode');
}

app.use(bodyParser.json());

// Endpoint for Telegram webhook
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Healthcheck endpoint
app.get('/', (req, res) => {
  res.send('Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
});

const AWAITING_DESCRIPTION = 'awaiting_description';
const AWAITING_PHOTOS = 'awaiting_photos';

// Validation constants
const MIN_WORDS = 5;
const MAX_WORDS = 500;
const MAX_PHOTOS = 8;
const MAX_POST_AGE_MINUTES = 60 * 24; 

// Установка команд бота
bot.setMyCommands([
  { command: '/start', description: 'Почати роботу з ботом' },
  { command: '/cancel', description: 'Скасувати створення оголошення' },
]);

// Создание пула соединений
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: 5432, 
  ssl: true 
});

// Хранилище для временных медиа групп (ключ: userId_mediaGroupId)
const mediaGroups = new Map();

const userCurrentPost = new Map(); // chatId -> postId

function sendMessageWithKeyboard(chatId, text, buttons, messageId = null) {
  const keyboard = { inline_keyboard: buttons.map(button => [{ text: button.text, callback_data: button.callback_data }]) };
  
  if (messageId) {
    return bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: keyboard
    });
  } else {
    return bot.sendMessage(chatId, text, {
      reply_markup: keyboard
    });
  }
}

// Функция для получения состояния пользователя из базы данных
async function getUserState(chatId) {
  const postId = userCurrentPost.get(chatId);
  const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
  const currentPost = rows[0];
  if (!currentPost) return null;

  return {
    ...currentPost,
    photos: currentPost.photos ? JSON.parse(currentPost.photos) : [],
    priceText: currentPost.price_text,
    username: currentPost.username
  };
}

// Функция для сохранения состояния пользователя в базе данных
async function saveUserState(chatId, post) {
  const postId = userCurrentPost.get(chatId);
  await pool.query(
    `UPDATE posts SET description = $1, stage = $2, photos = $3 WHERE id = $4`,
    [post.description, post.stage, JSON.stringify(post.photos), postId]
  );
}

// Функция для проверки активного поста
async function hasActivePost(chatId) {
  const { rows } = await pool.query(
    'SELECT * FROM posts WHERE user_chat_id = $1 AND stage NOT IN ($2)',
    [chatId, 'published']
  );
  return rows.length > 0;
}

// Обработка команды /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (!msg.from.username) {
    await bot.sendMessage(chatId, '⚠️ Для використання бота вам необхідно встановити ім\'я користувача (username) в налаштуваннях Telegram.\n\n🔄 Після встановлення username, надішліть /start знову.');
    return;
  }
  
  const activePost = await hasActivePost(chatId);
  if (activePost) {
    await bot.sendMessage(chatId, '⚠️ У вас вже є активне оголошення.\n\n✏️ Будь ласка, завершіть його створення або почніть спочатку.');
    return;
  }

  await pool.query('INSERT INTO users (chat_id, username) VALUES ($1, $2) ON CONFLICT (chat_id) DO UPDATE SET username = EXCLUDED.username', 
    [chatId, msg.from.username]);

  const menuButtons = [
    { text: '📝 Створити оголошення', callback_data: 'create_post' },
  ];
  await sendMessageWithKeyboard(chatId, '👋 Вітаю! Оберіть дію:', menuButtons);
});

// Обработка нажатий на кнопки
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  
  if (!query.from.username) {
    await bot.sendMessage(chatId, '⚠️ Для використання бота вам необхідно встановити ім\'я користувача (username) в налаштуваннях Telegram.');
    await bot.answerCallbackQuery(query.id);
    return;
  }
  
  if (query.data === 'create_post') {
    const hasActive = await hasActivePost(chatId);
    if (hasActive) {
      await bot.editMessageText('⚠️ У вас вже є активне оголошення.\n\n✏️ Будь ласка, завершіть його створення.', {
        chat_id: chatId,
        message_id: messageId
      });
      return;
    }

    const username = query.from.username 
      ? `@${query.from.username}`
      : query.from.first_name 
      ? `${query.from.first_name}${query.from.last_name ? ' ' + query.from.last_name : ''}` 
      : 'Невідомий користувач';

    const result = await pool.query(
      `INSERT INTO posts (user_chat_id, stage, photos, description, username)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [chatId, AWAITING_DESCRIPTION, '[]', '', username]
    );
    const postId = result.rows[0].id;
    userCurrentPost.set(chatId, postId);

    await saveUserState(chatId, {
      stage: AWAITING_DESCRIPTION,
      photos: [],
      description: '',
      username,
      photosFinished: false
    });
    await bot.editMessageText('📝 Будь ласка, надішліть опис для вашого оголошення:\n\n💡 Опишіть товар, його стан, ціну та умови продажу.\n\n❌ Щоб скасувати створення оголошення, надішліть /cancel', {
      chat_id: chatId,
      message_id: messageId
    });
  }
});

// Validation functions
function validateDescription(text) {
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount < MIN_WORDS) {
    return `Опис занадто короткий. Мінімальна кількість слів: ${MIN_WORDS}. Ви ввели: ${wordCount} слів.`;
  }
  if (wordCount > MAX_WORDS) {
    return `Опис занадто довгий. Максимальна кількість слів: ${MAX_WORDS}. Ви ввели: ${wordCount} слів.`;
  }
  return null;
}

// Обработка описания
bot.on('text', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text.startsWith('/')) return;

  const userState = await getUserState(chatId);
  const currentPost = userState;
  
  if (currentPost && currentPost.stage === AWAITING_DESCRIPTION) {
    const validationError = validateDescription(msg.text);
    if (validationError) {
      await bot.sendMessage(chatId, `⚠️ ${validationError}`);
      return;
    }

    currentPost.description = msg.text;
    currentPost.stage = AWAITING_PHOTOS;
    await saveUserState(chatId, currentPost);
    await bot.sendMessage(chatId, 
      '✅ Дякую за опис!\n\n' +
      '📸 Тепер надішліть фотографії для вашого оголошення:\n' +
      `• Максимальна кількість фото: ${MAX_PHOTOS}\n` +
      '• Ви можете надіслати декілька фото одразу\n' +
      '• Коли закінчите, натисніть кнопку "✅ Завершити"', {
      reply_markup: {
        inline_keyboard: [[{ text: '✅ Завершити', callback_data: 'finish_photos' }]]
      }
    });
  }
});

// Обработка фотографий
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userState = await getUserState(chatId);
  const currentPost = userState;

  if (!currentPost || currentPost.stage !== AWAITING_PHOTOS) return;

  // Если фото является частью медиа группы
  if (msg.media_group_id) {
    const mediaGroupKey = `${chatId}_${msg.media_group_id}`;
    let mediaGroup = mediaGroups.get(mediaGroupKey);
    if (!mediaGroup) {
      mediaGroup = {
        photos: [],
        timer: null,
        chatId: chatId,
        processed: false
      };
      mediaGroups.set(mediaGroupKey, mediaGroup);
    }

    if (mediaGroup.processed) return;

    const photo = msg.photo[msg.photo.length - 1];
    mediaGroup.photos.push(photo.file_id);

    if (mediaGroup.timer) {
      clearTimeout(mediaGroup.timer);
    }

    mediaGroup.timer = setTimeout(async () => {
      mediaGroup.processed = true;

      if (mediaGroup.photos.length > MAX_PHOTOS - currentPost.photos.length) {
        await bot.sendMessage(chatId, 
          '⚠️ Група фотографій не може бути додана:\n\n' +
          `📸 Кількість фото у групі: ${mediaGroup.photos.length}\n` +
          `📍 Максимальний ліміт: ${MAX_PHOTOS} фото`);
        mediaGroups.delete(mediaGroupKey);
        return;
      }

      currentPost.photos.push(...mediaGroup.photos);
      await saveUserState(chatId, currentPost);

      await bot.sendMessage(chatId, 
        '✅ Групу фотографій додано!\n\n' +
        `📸 Додано фото: ${mediaGroup.photos.length}\n` +
        `📍 Всього фото: ${currentPost.photos.length}/${MAX_PHOTOS}`);

      mediaGroups.delete(mediaGroupKey);
    }, 1000);

    return;
  }

  // Обработка одиночного фото
  if (currentPost.photos.length >= MAX_PHOTOS) {
    await bot.sendMessage(chatId, 
      '⚠️ Ви досягли максимальної кількості фотографій.\n\n' +
      `📸 Максимальний ліміт: ${MAX_PHOTOS} фото\n` +
      '✅ Натисніть "Завершити" для публікації.');
    return;
  }

  const photo = msg.photo[msg.photo.length - 1];
  currentPost.photos.push(photo.file_id);
  await saveUserState(chatId, currentPost);
  
  await bot.sendMessage(chatId, 
    '✅ Фотографію додано!\n\n' +
    `📸 Всього фото: ${currentPost.photos.length}/${MAX_PHOTOS}` +
    (currentPost.photos.length === MAX_PHOTOS ? '\n\n⚠️ Ви досягли максимальної кількості фотографій. Натисніть "✅ Завершити" для публікації.' : ''));
});

// Публикация поста
bot.on('callback_query', async (query) => {
  if (query.data === 'finish_photos') {
    const chatId = query.message.chat.id;
    const userState = await getUserState(chatId);
    const currentPost = userState;

    if (currentPost && currentPost.stage === AWAITING_PHOTOS) {
      if (currentPost.photos.length === 0) {
        await bot.sendMessage(chatId, '⚠️ Будь ласка, додайте хоча б одну фотографію.');
        return;
      }

      const caption = `📢 Нове оголошення від ${currentPost.username}\n\n${currentPost.description}`;
      
      if (currentPost.photos.length === 1) {
        await bot.sendPhoto(channelId, currentPost.photos[0], { caption });
      } else {
        const mediaGroup = currentPost.photos.map((photo, index) => ({
          type: 'photo',
          media: photo,
          caption: index === 0 ? caption : undefined
        }));
        await bot.sendMediaGroup(channelId, mediaGroup);
      }

      currentPost.stage = 'published';
      await saveUserState(chatId, currentPost);
      await bot.sendMessage(chatId, '🎉 Ваше оголошення успішно опубліковано!\n\n📝 Щоб створити нове оголошення, використайте команду /start');
    }
  }
});

// Периодическая очистка просроченных постов
setInterval(async () => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM posts
       WHERE stage != 'published'
         AND created_at < NOW() - INTERVAL '${MAX_POST_AGE_MINUTES} minutes'
       RETURNING id, user_chat_id`
    );
    for (const row of rows) {
      userCurrentPost.delete(row.user_chat_id);
      // Отправляем уведомление пользователю
      await bot.sendMessage(
        row.user_chat_id,
        '⏰ Ваше оголошення було автоматично видалено через неактивність. Будь ласка, створіть нове оголошення, якщо це потрібно \n\n /start'
      );
    }
    if (rows.length > 0) {
      console.log(`Автоматично удалено ${rows.length} просроченных постов`);
    }
  } catch (err) {
    console.error('Ошибка при автоочистке постов:', err);
  }
}, 60 * 1000);

bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const postId = userCurrentPost.get(chatId);

  if (!postId) {
    await bot.sendMessage(chatId, 'У вас немає активного оголошення для скасування.');
    return;
  }

  // Удаляем пост из базы, если он не опубликован
  await pool.query(
    "DELETE FROM posts WHERE id = $1 AND stage != 'published'",
    [postId]
  );

  userCurrentPost.delete(chatId);

  await bot.sendMessage(chatId, 'Ваше оголошення скасовано. Щоб створити нове, використайте /start.');
});
