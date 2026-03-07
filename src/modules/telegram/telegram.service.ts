import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/**
 * Thin wrapper around the Telegram Bot HTTP API.
 *
 * Responsibilities:
 *   1. Register the Railway webhook URL with Telegram on startup (onModuleInit)
 *   2. Send structured bounty dispatch messages to agent chat IDs
 *   3. Send the /start reply with the chat ID so agents can register
 *
 * No telegraf / grammy dependency — uses plain axios to keep the bundle lean.
 */
@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private readonly apiBase: string;
  private readonly webhookSecret: string;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    const token = this.config.get<string>('telegram.botToken') ?? '';
    this.enabled = token.length > 0;
    this.apiBase = `https://api.telegram.org/bot${token}`;
    this.webhookSecret = this.config.get<string>('telegram.webhookSecret') ?? '';
  }

  /**
   * Registers the Railway backend URL as the Telegram webhook on startup.
   * Safe to call on every deploy — Telegram ignores duplicate setWebhook calls
   * when the URL hasn't changed.
   * Skipped in development (no public URL) or when bot token is absent.
   */
  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram dispatch disabled');
      return;
    }

    const apiUrl = this.config.get<string>('apiUrl') ?? '';
    const nodeEnv = this.config.get<string>('nodeEnv') ?? 'development';

    /* Only register webhook in production — dev has no public URL */
    if (nodeEnv !== 'production' || !apiUrl || apiUrl.includes('localhost')) {
      this.logger.log('Skipping Telegram webhook registration (non-production or localhost)');
      return;
    }

    const webhookUrl = `${apiUrl}/telegram/webhook`;

    try {
      await axios.post(`${this.apiBase}/setWebhook`, {
        url: webhookUrl,
        secret_token: this.webhookSecret,
        allowed_updates: ['message'],
      });
      this.logger.log(`Telegram webhook registered → ${webhookUrl}`);
    } catch (err) {
      /* Non-fatal — bot still works via polling fallback if webhook fails */
      this.logger.error('Failed to register Telegram webhook', err);
    }
  }

  /**
   * Sends the /start reply to a user who messaged the bot.
   * Tells them their chat ID so they can paste it into the Envoy app.
   */
  async sendStartReply(chatId: number | string): Promise<void> {
    if (!this.enabled) return;
    await this.send(chatId, [
      '👋 <b>Welcome to Envoy!</b>',
      '',
      '🔑 Your Telegram Chat ID is:',
      `<code>${chatId}</code>`,
      '',
      'Copy this and paste it into the <b>Telegram Chat ID</b> field when registering your agent on Envoy.',
      'Once registered, this chat will receive all bounty dispatches automatically.',
    ].join('\n'));
  }

  /**
   * Sends a formatted bounty dispatch message to an agent's Telegram chat.
   * The message includes the registration ID in a clearly parseable format
   * so the agent's reply can be matched back to the correct bounty.
   */
  async sendBountyDispatch(params: {
    chatId: string;
    registrationId: string;
    bountyId: string;
    title: string;
    description: string;
    category: string;
    deliverableFormat: string;
    prizeUsdc: number;
    submissionDeadline: string;
  }): Promise<void> {
    if (!this.enabled) {
      this.logger.warn(`Telegram disabled — skipping dispatch to chat ${params.chatId}`);
      return;
    }

    const deadline = new Date(params.submissionDeadline).toUTCString();

    const message = [
      '🎯 <b>New Bounty Dispatched</b>',
      '',
      `📋 <b>Title:</b> ${params.title}`,
      `💰 <b>Prize:</b> $${params.prizeUsdc} USDC`,
      `📁 <b>Category:</b> ${params.category}`,
      `📄 <b>Format:</b> ${params.deliverableFormat}`,
      `⏰ <b>Deadline:</b> ${deadline}`,
      '',
      `📝 <b>Description:</b>`,
      params.description,
      '',
      '─────────────────────',
      `🔖 <b>Registration ID:</b>`,
      `<code>${params.registrationId}</code>`,
      '',
      'To submit your work, reply with:',
      `<code>[${params.registrationId}] Your deliverable content here</code>`,
    ].join('\n');

    await this.send(params.chatId, message);
    this.logger.log(`Bounty dispatch sent to Telegram chat ${params.chatId} for bounty ${params.bountyId}`);
  }

  /** Sends a plain HTML-formatted message to a Telegram chat. */
  async send(chatId: number | string, text: string): Promise<void> {
    await axios.post(`${this.apiBase}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    });
  }

  /** Returns whether Telegram dispatch is configured and active. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Returns the webhook secret for request verification in the controller. */
  get secret(): string {
    return this.webhookSecret;
  }
}
