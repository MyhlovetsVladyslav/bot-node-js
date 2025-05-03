const mysql = require('mysql2/promise');
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const token = process.env.BOT_TOKEN;
const channelId = process.env.CHANNEL_ID;
const moderatorChatId = process.env.MODERATOR_CHAT_ID;
const bot = new TelegramBot(token, { polling: true });
const AWAITING_PAYMENT_RECEIPT = 'awaiting_payment_receipt';
const AWAITING_DESCRIPTION = 'awaiting_description';
const AWAITING_PHOTOS = 'awaiting_photos';

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

// Функция для редактирования сообщения с клавиатурой
async function editMessageWithKeyboard(chatId, messageId, text, buttons) {
  try {
    return await sendMessageWithKeyboard(chatId, text, buttons, messageId);
  } catch (error) {
    console.error('Error editing message:', error);
    // Если сообщение не может быть отредактировано (например, слишком старое),
    // отправляем новое сообщение
    return sendMessageWithKeyboard(chatId, text, buttons);
  }
}

// Функция для получения состояния пользователя из базы данных
async function getUserState(chatId) {
  const [rows] = await pool.query('SELECT * FROM posts WHERE user_chat_id = ?', [chatId]);
  return rows.map(row => {
    let photos = [];
    try {
      photos = row.photos ? JSON.parse(row.photos) : [];
    } catch (error) {
      console.error('Error parsing photos for post id ' + row.id, error);
    }
    return {
      ...row,
      photos,
      priceText: row.price_text, // Маппируем поле price_text в priceText
      username: row.username // Маппируем username
    };
  });
}

// Функция для сохранения состояния пользователя в базе данных
async function saveUserState(chatId, post) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query(
      `INSERT INTO posts (id, user_chat_id, stage, photos, description, receipt, price, price_text, username, has_sent_instruction, photos_finished)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       stage = VALUES(stage),
       photos = VALUES(photos),
       description = VALUES(description),
       receipt = VALUES(receipt),
       price = VALUES(price),
       price_text = VALUES(price_text),
       username = VALUES(username),
       has_sent_instruction = VALUES(has_sent_instruction),
       photos_finished = VALUES(photos_finished)`,
      [
        post.id, // Используем оригинальный id поста
        chatId,
        post.stage,
        JSON.stringify(post.photos),
        post.description,
        post.receipt,
        post.price,
        post.priceText || null,
        post.username || 'Невідомий користувач',
        post.hasSentInstruction,
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
    'SELECT * FROM posts WHERE user_chat_id = ? AND stage NOT IN (?, ?)',
    [chatId, 'published', 'rejected']
  );
  return rows.length > 0;
}

// Функция для обработки команды /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Проверяем наличие username
  if (!msg.from.username) {
    await bot.sendMessage(chatId, 'Для використання бота вам необхідно встановити ім\'я користувача (username) в налаштуваннях Telegram. Після встановлення username, надішліть /start знову.');
    return;
  }
  
  let user = await getUserState(chatId);
  if (!user.length) {
    await pool.query('INSERT INTO users (chat_id, username) VALUES (?, ?) ON DUPLICATE KEY UPDATE username = ?', [chatId, msg.from.username, msg.from.username]);
    user = [];
  }
  try {
    const menuButtons = [
      { text: 'Продаж книг', callback_data: 'sell_books' },
      { text: 'Пошук', callback_data: 'search_books' }
    ];
    await sendMessageWithKeyboard(chatId, 'Привіт! Виберіть команду:', menuButtons);
  } catch (error) {
    console.error('Error sending menu:', error);
  }
});

// Функция для проверки username у пользователя
async function checkUsername(msg) {
  if (!msg.from.username) {
    await bot.sendMessage(msg.chat.id, 'Для використання бота вам необхідно встановити ім\'я користувача (username) в налаштуваннях Telegram. Після встановлення username, надішліть /start знову.');
    return false;
  }
  return true;
}

// Функция для обработки кнопок
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  
  // Проверяем наличие username
  if (!query.from.username) {
    await bot.sendMessage(chatId, 'Для використання бота вам необхідно встановити ім\'я користувача (username) в налаштуваннях Telegram. Після встановлення username, надішліть /start знову.');
    await bot.answerCallbackQuery(query.id);
    return;
  }
  
  let user = await getUserState(chatId);

  try {
    if (query.data === 'sell_books') {
      // Проверяем наличие активного поста
      const hasActive = await hasActivePost(chatId);
      if (hasActive) {
        await editMessageWithKeyboard(chatId, messageId, 'У вас вже є активний пост. Будь ласка, завершіть його або дочекайтеся модерації.', [
          { text: 'Назад', callback_data: 'back_to_menu' }
        ]);
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
        stage: 'awaiting_book_count',
        photos: [],
        description: '',
        receipt: '',
        price: '',
        priceText: '',
        hasSentInstruction: false,
        username
      };
      user.push(newPost);
      await saveUserState(chatId, newPost);
      await editMessageWithKeyboard(chatId, messageId, 'Виберіть кількість книг:', [
        { text: '1-4 книги - 5 грн', callback_data: 'books_1_4' },
        { text: '5-9 книг - 10 грн', callback_data: 'books_5_9' },
        { text: '10-14 книг - 15 грн', callback_data: 'books_10_14' },
        { text: '15-19 книг - 20 грн', callback_data: 'books_15_19' },
        { text: '20-24 книги - 25 грн', callback_data: 'books_20_24' },
        { text: '25-30 книг - 30 грн', callback_data: 'books_25_30' },
        { text: 'Назад', callback_data: 'back_to_menu' }
      ]);
    } else if (query.data.startsWith('books_')) {
      const priceMap = {
        'books_1_4': { price: '5 грн', text: '1-4 книги - 5 грн' },
        'books_5_9': { price: '10 грн', text: '5-9 книг - 10 грн' },
        'books_10_14': { price: '15 грн', text: '10-14 книг - 15 грн' },
        'books_15_19': { price: '20 грн', text: '15-19 книг - 20 грн' },
        'books_20_24': { price: '25 грн', text: '20-24 книги - 25 грн' },
        'books_25_30': { price: '30 грн', text: '25-30 книг - 30 грн' }
      };

      const currentPost = user[user.length - 1];
      const selected = priceMap[query.data];
      currentPost.price = selected.price;
      currentPost.priceText = selected.text;
      currentPost.stage = AWAITING_PAYMENT_RECEIPT;

      await saveUserState(chatId, currentPost);
      await editMessageWithKeyboard(chatId, messageId, `Ви вибрали ${selected.text}. Надішліть квитанцію про оплату.`, [
        { text: 'Назад', callback_data: 'back_to_book_count' }
      ]);
    } else if (query.data === 'back_to_book_count') {
      const currentPost = user[user.length - 1];
      currentPost.stage = 'awaiting_book_count';
      currentPost.price = '';
      currentPost.priceText = '';
      await saveUserState(chatId, currentPost);
      await editMessageWithKeyboard(chatId, messageId, 'Виберіть кількість книг:', [
        { text: '1-4 книги - 5 грн', callback_data: 'books_1_4' },
        { text: '5-9 книг - 10 грн', callback_data: 'books_5_9' },
        { text: '10-14 книг - 15 грн', callback_data: 'books_10_14' },
        { text: '15-19 книг - 20 грн', callback_data: 'books_15_19' },
        { text: '20-24 книги - 25 грн', callback_data: 'books_20_24' },
        { text: '25-30 книг - 30 грн', callback_data: 'books_25_30' },
        { text: 'Назад', callback_data: 'back_to_menu' }
      ]);
    } else if (query.data === 'back_to_menu') {
      const currentPost = user[user.length - 1];
      // Удаляем неактивный пост из базы данных
      await pool.query('DELETE FROM posts WHERE id = ?', [currentPost.id]);
      await editMessageWithKeyboard(chatId, messageId, 'Привіт! Виберіть команду:', [
        { text: 'Продаж книг', callback_data: 'sell_books' },
        { text: 'Пошук', callback_data: 'search_books' }
      ]);
    } else if (query.data === 'search_books') {
      await editMessageWithKeyboard(chatId, messageId, 'Функція пошуку поки в розробці.', [
        { text: 'Назад', callback_data: 'back_to_menu' }
      ]);
    } else if (query.data === 'finish_photos') {
      const currentPost = user[user.length - 1];
      if (currentPost && currentPost.photos.length > 0) {
        clearTimeout(currentPost.photoNotificationTimer);
        currentPost.photosFinished = true;
        currentPost.stage = AWAITING_DESCRIPTION; 
        await saveUserState(chatId, currentPost);
        await editMessageWithKeyboard(chatId, messageId, `Додавання фотографій завершено. Всього додано: ${currentPost.photos.length}. Тепер надішліть опис до вашого посту.`, []);
      } else {
        await editMessageWithKeyboard(chatId, messageId, 'Ви не додали жодної фотографії. Будь ласка, надішліть хоча б одне фото.', [
          { text: 'Завершити додавання фото', callback_data: 'finish_photos' }
        ]);
      }
    } else {
      await handleModeratorActions(query);
    }

    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.error('Error handling callback query:', error);
  }
});

// Добавляем специфичные обработчики
const mediaGroups = {};

// Функция для очистки старых медиа-групп (старше 5 минут)
function cleanupOldMediaGroups() {
  const now = Date.now();
  const fiveMinutesAgo = now - 5 * 60 * 1000;
  
  for (const key in mediaGroups) {
    if (mediaGroups[key].timestamp < fiveMinutesAgo) {
      delete mediaGroups[key];
    }
  }
}

// Запускаем очистку каждые 5 минут
setInterval(cleanupOldMediaGroups, 5 * 60 * 1000);

// Функция для обработки фотографий
async function handlePhotos(msg, chatId, post) {
  if (!msg.photo) {
    await bot.sendMessage(chatId, 'Будь ласка, надішліть фотографію або натисніть "Завершити додавання фото".', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Завершити додавання фото', callback_data: 'finish_photos' }]
        ]
      }
    });
    return;
  }
  
  // Проверяем, является ли фото частью медиа-группы
  if (msg.media_group_id) {
    // Создаем уникальный ключ для медиа-группы, привязанный к конкретному пользователю
    const groupKey = `${chatId}_${msg.media_group_id}`;
    
    // Если это новая медиа-группа, инициализируем её
    if (!mediaGroups[groupKey]) {
      mediaGroups[groupKey] = {
        chatId: chatId,
        postId: post.id, // Сохраняем ID поста для безопасности
        photos: [],
        timestamp: Date.now(),
        processed: false
      };
      
      // Устанавливаем таймер для обработки медиа-группы после того, как все фото будут получены
      setTimeout(async () => {
        try {
          const group = mediaGroups[groupKey];
          if (!group || group.processed) return;
          
          group.processed = true;
          
          // Получаем текущее состояние поста из БД для безопасности
          let user = await getUserState(chatId);
          let currentPost = user.find(p => p.id === group.postId);
          
          if (currentPost && currentPost.stage === AWAITING_PHOTOS) {
            // Добавляем все фото из группы в пост
            const photoIds = group.photos.map(photo => photo.file_id);
            currentPost.photos = currentPost.photos.concat(photoIds);
            
            // Отправляем одно сообщение для всей группы
            if (!currentPost.hasSentInstruction) {
              await bot.sendMessage(chatId, `Отримано ${photoIds.length} фото. Всього: ${currentPost.photos.length}. Ви можете надіслати ще фотографії або натисніть кнопку "Завершити додавання фото", щоб перейти до додавання опису.`, {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: 'Завершити додавання фото', callback_data: 'finish_photos' }]
                  ]
                }
              });
              currentPost.hasSentInstruction = true;
            }
            
            await saveUserState(chatId, currentPost);
          }
          
          // Удаляем обработанную группу
          delete mediaGroups[groupKey];
        } catch (error) {
          console.error('Ошибка обработки медиа-группы:', error);
          // Очищаем группу даже в случае ошибки
          delete mediaGroups[groupKey];
        }
      }, 2000); // Ждем 2 секунды, чтобы все фото группы были получены
    }
    
    // Добавляем фото в медиа-группу
    mediaGroups[groupKey].photos.push(msg.photo[msg.photo.length - 1]);
    
    // ВАЖНО: Не добавляем фото в пост непосредственно здесь, 
    // это будет сделано в таймере когда вся группа будет получена
  } else {
    // Добавляем фото в коллекцию (для одиночных фото)
    const photoId = msg.photo[msg.photo.length - 1].file_id;
    post.photos.push(photoId);
    
    // Если это одиночное фото, обрабатываем стандартно
    // Очищаем предыдущий таймер, если он есть
    if (post.photoNotificationTimer) {
      clearTimeout(post.photoNotificationTimer);
    }
    
    // Устанавливаем новый таймер
    post.photoNotificationTimer = setTimeout(async () => {
      if (!post.hasSentInstruction) {
        await bot.sendMessage(chatId, `Отримано ${post.photos.length} фото. Ви можете надіслати ще фотографії або натисніть кнопку "Завершити додавання фото", щоб перейти до додавання опису.`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Завершити додавання фото', callback_data: 'finish_photos' }]
            ]
          }
        });
        post.hasSentInstruction = true;
      }
    }, 1000);
  }
}

bot.on('text', async (msg) => {
  // Пропускаем проверку для команды /start, так как она обрабатывается отдельно
  if (msg.text === '/start') return;
  
  const chatId = msg.chat.id;
  
  // Проверяем наличие username
  if (!await checkUsername(msg)) return;
  
  let user = await getUserState(chatId);
  if (user.length === 0) return;

  const currentPost = user[user.length - 1];
  try {
    if (currentPost.stage === AWAITING_DESCRIPTION) {
      await handleDescription(msg, chatId, currentPost);
    }
    await saveUserState(chatId, currentPost);
  } catch (error) {
    console.error('Error handling text:', error);
  }
});

async function sendPostForModeration(msg, post) {
  if (!post.photos || post.photos.length === 0) {
    await editMessageWithKeyboard(msg.chat.id, msg.message_id, 'Помилка: немає фотографій для публікації.', [
      { text: 'Продаж книг', callback_data: 'sell_books' },
      { text: 'Пошук', callback_data: 'search_books' }
    ]);
    return;
  }
  try {
    await bot.sendPhoto(moderatorChatId, post.receipt, {
      caption: `Кількість книг: ${post.priceText || 'Не вказано'}\nКористувач: ${post.username || 'Невідомий користувач'}\n\nВиберіть дію:`,
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Опублікувати', callback_data: `approve_${msg.chat.id}_${post.id}` }],
          [{ text: 'Відхилити', callback_data: `reject_${msg.chat.id}_${post.id}` }]
        ]
      }
    });
  } catch (error) {
    console.error('Error sending post for moderation:', error);
    await editMessageWithKeyboard(msg.chat.id, msg.message_id, 'Сталася помилка при відправці поста на модерацію. Будь ласка, спробуйте ще раз.', [
      { text: 'Продаж книг', callback_data: 'sell_books' },
      { text: 'Пошук', callback_data: 'search_books' }
    ]);
  }
}

// Обработка действий модератора (публикация или отклонение)
async function handleModeratorActions(query) {
  const [action, userChatId, postId] = query.data.split('_');
  let user = await getUserState(userChatId);
  const post = user.find(p => p.id == postId);
  if (post) {
    if (action === 'approve') {
      if (post.photos && post.photos.length > 0) {
        const mediaGroup = post.photos.map((photo, index) => ({
          type: 'photo',
          media: photo, 
          caption: index === 0 ? `${post.description}\n\nОпублікував: ${post.username || 'Невідомий користувач'}` : ''
        }));

        try {
          await bot.sendMediaGroup(channelId, mediaGroup);
          // Вместо редактирования отправляем новое сообщение
          await bot.sendMessage(userChatId, 'Ваш пост опубліковано в каналі.', {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: 'Продаж книг', callback_data: 'sell_books' },
                  { text: 'Пошук', callback_data: 'search_books' }
                ]
              ]
            }
          });
          post.stage = 'published';
        } catch (error) {
          console.error('Error sending media group:', error);
          // Вместо редактирования отправляем новое сообщение об ошибке
          await bot.sendMessage(userChatId, 'Сталася помилка при публікації вашого поста. Будь ласка, спробуйте ще раз.', {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: 'Продаж книг', callback_data: 'sell_books' },
                  { text: 'Пошук', callback_data: 'search_books' }
                ]
              ]
            }
          });
        }
      } else {
        // Вместо редактирования отправляем новое сообщение об ошибке
        await bot.sendMessage(userChatId, 'Помилка: немає фотографій для публікації.', {
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Продаж книг', callback_data: 'sell_books' },
                { text: 'Пошук', callback_data: 'search_books' }
              ]
            ]
          }
        });
      }
    } else if (action === 'reject') {
      // Вместо редактирования отправляем новое сообщение
      await bot.sendMessage(userChatId, 'Ваш пост було відхилено модератором.', {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Продаж книг', callback_data: 'sell_books' },
              { text: 'Пошук', callback_data: 'search_books' }
            ]
          ]
        }
      });
      post.stage = 'rejected';
    }
    await saveUserState(userChatId, post);
  }
  // Удаляем сообщение модератора
  await bot.deleteMessage(query.message.chat.id, query.message.message_id);
}

async function handleDescription(msg, chatId, post) {
  if (post.stage === AWAITING_DESCRIPTION) {
    if (!msg.text) {
      await bot.sendMessage(chatId, 'Будь ласка, надішліть текстове описання для вашого поста.');
      return;
    }

    post.description = msg.text;
    post.stage = 'awaiting_moderation';
    await sendPostForModeration(msg, post);
    await saveUserState(chatId, post);
    
    // Вместо редактирования отправляем новое сообщение
    await bot.sendMessage(chatId, 'Ваш пост відправлено на модерацію. Ви можете створити новий пост або виконати пошук.', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Продаж книг', callback_data: 'sell_books' },
            { text: 'Пошук', callback_data: 'search_books' }
          ]
        ]
      }
    });
  }
}

// Функция для обработки квитанции
async function handleReceipt(msg, chatId, post) {
  if (msg.photo) {
    post.receipt = msg.photo[msg.photo.length - 1].file_id;
    post.stage = AWAITING_PHOTOS;
    
    // Удаляем предыдущее сообщение бота
    try {
      await bot.deleteMessage(chatId, msg.message_id - 1);
    } catch (error) {
      console.error('Error deleting previous message:', error);
    }
    
    await bot.sendMessage(chatId, 'Квитанція отримана. Надішліть фотографії книг.');
  } else {
    await editMessageWithKeyboard(chatId, msg.message_id, 'Будь ласка, надішліть квитанцію про оплату.', [
      { text: 'Назад', callback_data: 'back_to_book_count' }
    ]);
  }
}

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  
  if (!await checkUsername(msg)) return;
  
  let user = await getUserState(chatId);
  if (user.length === 0) return;

  const currentPost = user[user.length - 1];
  try {
    if (currentPost.stage === AWAITING_PAYMENT_RECEIPT) {
      await handleReceipt(msg, chatId, currentPost);
    } else if (currentPost.stage === AWAITING_PHOTOS) {
      await handlePhotos(msg, chatId, currentPost);
    }
    await saveUserState(chatId, currentPost);
  } catch (error) {
    console.error('Error handling photo:', error);
  }
});