# Telegram Book Marketplace Bot

A Telegram bot that facilitates a book marketplace where users can sell books through a moderated channel.

## Features

- Users can create posts to sell books
- Support for multiple photos per post
- Price tiers based on book quantity
- Payment verification through receipts
- Moderation system for post approval
- User-friendly inline keyboard navigation

## Setup

1. Clone this repository
2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file with the following variables:
```
BOT_TOKEN=your_telegram_bot_token
CHANNEL_ID=your_channel_id
MODERATOR_CHAT_ID=your_moderator_chat_id
DB_HOST=your_database_host
DB_USER=your_database_user
DB_PASSWORD=your_database_password
DB_NAME=your_database_name
```

4. Start the bot:
```bash
node bot.js
```

## Environment Variables

- `BOT_TOKEN`: Your Telegram Bot Token from BotFather
- `CHANNEL_ID`: ID of the channel where approved posts will be published
- `MODERATOR_CHAT_ID`: Chat ID for moderators
- `DB_HOST`: MySQL database host
- `DB_USER`: MySQL database user
- `DB_PASSWORD`: MySQL database password
- `DB_NAME`: MySQL database name

## Project Structure

- `bot.js` - Main bot logic
- `docker/` - Docker configuration files
- `logs/` - Application logs 