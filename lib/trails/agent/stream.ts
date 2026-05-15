import { trailsBot } from '../bot-api';

const EDIT_DEBOUNCE_MS = 300;

/**
 * Debounced wrapper around bot.editMessageText. Coalesces multiple delta edits
 * inside `EDIT_DEBOUNCE_MS` into a single request. Use one `MessageEditor` per
 * Telegram message id.
 */
export class MessageEditor {
  private readonly chatId: number;
  private readonly messageId: number;
  private latestText: string;
  private lastSentText: string;
  private pendingTimer: NodeJS.Timeout | null = null;
  private editInFlight: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(args: { chatId: number; messageId: number; initialText: string }) {
    this.chatId = args.chatId;
    this.messageId = args.messageId;
    this.latestText = args.initialText;
    this.lastSentText = args.initialText;
  }

  /** Queue an edit. Coalesced with later updates inside the debounce window. */
  update(text: string): void {
    if (this.closed) return;
    this.latestText = text;
    if (this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.flush();
    }, EDIT_DEBOUNCE_MS);
  }

  private flush(): void {
    if (this.closed) return;
    if (this.latestText === this.lastSentText) return;
    const text = this.latestText;
    this.lastSentText = text;
    this.editInFlight = this.editInFlight
      .then(() =>
        trailsBot()
          .editMessageText(this.chatId, this.messageId, text, {
            parseMode: 'HTML',
            disableWebPagePreview: true,
          })
          .catch((err) => {
            console.warn('[TrailsAgent] editMessageText failed:', err);
          })
      )
      .catch(() => {});
  }

  /** Force-flush any pending edit and wait for it to settle. */
  async finalize(text?: string): Promise<void> {
    if (this.closed) return;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (text !== undefined) this.latestText = text;
    this.flush();
    await this.editInFlight;
    this.closed = true;
  }
}
