const mysql = require('mysql2/promise');
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const token = process.env.BOT_TOKEN;
const channelId = process.env.CHANNEL_ID;
const bot = new TelegramBot(token, { polling: true });

const AWAITING_DESCRIPTION = 'awaiting_description';
const AWAITING_PHOTOS = 'awaiting_photos';

// Validation constants
const MIN_WORDS = 10;
const MAX_WORDS = 500;
const MAX_PHOTOS = 4;
// Установка команд бота
bot.setMyCommands([
  { command: '/start', description: 'Почати роботу з ботом' },
]);

// Создание пула соединений
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Хранилище для временных медиа групп (ключ: userId_mediaGroupId)
const mediaGroups = new Map();

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
  const [rows] = await pool.query('SELECT * FROM posts WHERE user_chat_id = ?', [chatId]);
  return rows.map(row => ({
    ...row,
    photos: row.photos ? JSON.parse(row.photos) : [],
    priceText: row.price_text,
    username: row.username
  }));
}

// Функция для сохранения состояния пользователя в базе данных
async function saveUserState(chatId, post) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO posts (id, user_chat_id, stage, photos, description, username, photos_finished)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       stage = VALUES(stage),
       photos = VALUES(photos),
       description = VALUES(description),
       username = VALUES(username),
       photos_finished = VALUES(photos_finished)`,
      [
        post.id,
        chatId,
        post.stage,
        JSON.stringify(post.photos),
        post.description,
        post.username,
        post.photosFinished
      ]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error('Error saving user state for chatId ' + chatId, error);
    throw error;
  } finally {
    connection.release();
  }
}

// Функция для проверки активного поста
async function hasActivePost(chatId) {
  const [rows] = await pool.query(
    'SELECT * FROM posts WHERE user_chat_id = ? AND stage NOT IN (?)',
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

  await pool.query('INSERT INTO users (chat_id, username) VALUES (?, ?) ON DUPLICATE KEY UPDATE username = ?', 
    [chatId, msg.from.username, msg.from.username]);

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

    const postId = Date.now();
    const username = query.from.username 
      ? `@${query.from.username}`
      : query.from.first_name 
      ? `${query.from.first_name}${query.from.last_name ? ' ' + query.from.last_name : ''}` 
      : 'Невідомий користувач';

    const newPost = {
      id: postId,
      stage: AWAITING_DESCRIPTION,
      photos: [],
      description: '',
      username,
      photosFinished: false
    };

    await saveUserState(chatId, newPost);
    await bot.editMessageText('📝 Будь ласка, надішліть опис для вашого оголошення:\n\n💡 Опишіть товар, його стан, ціну та умови продажу.', {
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
  const currentPost = userState[userState.length - 1];
  
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
  const currentPost = userState[userState.length - 1];

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
    const currentPost = userState[userState.length - 1];

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
