import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { TelegramService } from './telegram.service';

/**
 * Minimal Telegram Update shape — only the fields we need.
 * Telegram sends far more but we only care about message.text, message.chat.id,
 * and message.from.id for processing replies.
 */
interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; first_name?: string };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/**
 * Receives incoming Telegram webhook updates.
 *
 * Two events are handled:
 *   /start → Reply with the user's chat ID so they can register their agent
 *   [registrationId] <content> → Parse the reply and create a deliverable submission
 *
 * Security: every incoming request must carry the X-Telegram-Bot-Api-Secret-Token
 * header matching TELEGRAM_WEBHOOK_SECRET. Telegram adds this automatically when
 * the webhook URL is registered via setWebhook({ secret_token }).
 */
@ApiTags('telegram')
@Controller('telegram')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);
  private readonly supabase: SupabaseClient;

  /**
   * Pattern that agents must use when submitting via Telegram:
   *   [<uuid>] <content>
   * The UUID is the bounty_registration.id returned in the dispatch message.
   */
  private static readonly REPLY_PATTERN = /^\[([0-9a-f-]{36})\]\s*([\s\S]+)/i;

  constructor(
    private readonly telegramService: TelegramService,
    private readonly config: ConfigService,
  ) {
    this.supabase = createClient(
      config.get<string>('supabase.url') ?? '',
      config.get<string>('supabase.serviceKey') ?? '',
    );
  }

  /**
   * Telegram calls this endpoint for every incoming message.
   * Always returns 200 — Telegram will retry on non-200 responses.
   */
  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Telegram bot webhook — receives agent messages and /start commands' })
  @ApiResponse({ status: 200, description: 'Update processed' })
  async handleUpdate(
    @Body() update: TelegramUpdate,
    @Headers('x-telegram-bot-api-secret-token') incomingSecret: string,
  ): Promise<{ ok: boolean }> {
    /* Verify the request came from Telegram using our shared secret */
    const expectedSecret = this.telegramService.secret;
    if (expectedSecret && incomingSecret !== expectedSecret) {
      this.logger.warn('Rejected Telegram webhook — invalid secret token');
      throw new UnauthorizedException('Invalid secret token');
    }

    const message = update.message;
    if (!message?.text) return { ok: true };

    const chatId = message.chat.id;
    const text = message.text.trim();

    /* ── /start command: reply with the chat ID ── */
    if (text === '/start' || text.startsWith('/start ')) {
      await this.telegramService.sendStartReply(chatId);
      return { ok: true };
    }

    /* ── Submission reply: [registrationId] content ── */
    const match = TelegramController.REPLY_PATTERN.exec(text);
    if (match) {
      const registrationId = match[1];
      const content = match[2].trim();
      await this.processSubmission(chatId, registrationId, content, message.message_id);
    }

    return { ok: true };
  }

  /**
   * Processes a submission reply from a Telegram agent.
   *
   * Flow:
   *   1. Look up the bounty_registration by registrationId
   *   2. Verify the agent's telegram_chat_id matches the sender
   *   3. Create a deliverable record (text content stored in notes)
   *   4. Update the bounty_registration.deliverable_id
   *   5. Confirm to the agent via reply message
   */
  private async processSubmission(
    chatId: number,
    registrationId: string,
    content: string,
    messageId: number,
  ): Promise<void> {
    this.logger.log(`Processing Telegram submission for registration ${registrationId}`);

    /* Step 1: Load the registration + agent + bounty in one join */
    const { data: reg, error: regErr } = await this.supabase
      .from('bounty_registrations')
      .select('*, agents(telegram_chat_id, id), bounties(id, deliverable_format, category)')
      .eq('id', registrationId)
      .single();

    if (regErr || !reg) {
      this.logger.warn(`Registration ${registrationId} not found`);
      await this.telegramService.send(
        chatId,
        `❌ Registration ID <code>${registrationId}</code> not found. Check the ID and try again.`,
      );
      return;
    }

    /* Step 2: Verify the sender's chat ID matches the agent's registered telegram_chat_id */
    const agentChatId = reg.agents?.telegram_chat_id;
    if (String(agentChatId) !== String(chatId)) {
      this.logger.warn(`Chat ID mismatch for registration ${registrationId}: expected ${agentChatId}, got ${chatId}`);
      await this.telegramService.send(chatId, '❌ This registration belongs to a different agent.');
      return;
    }

    /* Step 3: Guard against double submission */
    if (reg.deliverable_id) {
      await this.telegramService.send(chatId, '⚠️ A submission for this registration already exists.');
      return;
    }

    /* Step 4: Create the deliverable record */
    const { data: deliverable, error: delErr } = await this.supabase
      .from('deliverables')
      .insert({
        bounty_id: reg.bounty_id,
        registration_id: registrationId,
        agent_id: reg.agent_id,
        /* Synthetic URL identifies the source message for audit trail */
        deliverable_url: `telegram://chat/${chatId}/msg/${messageId}`,
        deliverable_format: reg.bounties?.deliverable_format ?? 'document',
        hosted_url: null,
        /* Full submission text stored in notes */
        notes: content,
      })
      .select('id')
      .single();

    if (delErr || !deliverable) {
      this.logger.error(`Failed to create deliverable for registration ${registrationId}`, delErr);
      await this.telegramService.send(chatId, '❌ Failed to save your submission. Please try again.');
      return;
    }

    /* Step 5: Link deliverable back to the registration */
    await this.supabase
      .from('bounty_registrations')
      .update({ deliverable_id: deliverable.id, dispatch_state: 'dispatched' })
      .eq('id', registrationId);

    this.logger.log(`Deliverable ${deliverable.id} created for registration ${registrationId}`);

    /* Step 6: Confirm to the agent */
    await this.telegramService.send(
      chatId,
      [
        '✅ <b>Submission received!</b>',
        '',
        `📎 Deliverable ID: <code>${deliverable.id}</code>`,
        `🔖 Registration: <code>${registrationId}</code>`,
        '',
        'The bounty client will review your work and select a winner.',
      ].join('\n'),
    );
  }
}
