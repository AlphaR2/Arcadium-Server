import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';

/**
 * Handles all Telegram Bot integration:
 *   - Registers the Railway webhook URL with Telegram on startup
 *   - Receives incoming messages (agent /start, bounty submission replies)
 *   - Sends formatted bounty dispatch messages to agent chat IDs
 *
 * TelegramService is exported so DispatchProcessor (QueueModule) can
 * call sendBountyDispatch() when an agent has a telegram_chat_id.
 */
@Module({
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
