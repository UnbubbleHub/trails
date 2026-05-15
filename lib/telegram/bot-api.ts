/**
 * Telegram Bot API helpers using raw fetch (no SDK).
 *
 * Two ways to use:
 *   1. Named exports (`sendMessage`, `sendPhoto`, ...) default to the
 *      `TELEGRAM_API_SECRET` token — used by the original @UnbubbleNewsBot.
 *   2. `createTelegramBotApi(token)` returns the same surface bound to a
 *      different token — used by the Trails bot (`TELEGRAM_TRAILS_API_SECRET`).
 */

function defaultBotToken(): string {
  const token = process.env.TELEGRAM_API_SECRET;
  if (!token) throw new Error('TELEGRAM_API_SECRET is not set');
  return token;
}

function apiUrlFor(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/** Telegram inline keyboard button — either a URL opener or a callback trigger. */
export type InlineKeyboardButton =
  | { text: string; url: string }
  | { text: string; callback_data: string };

/**
 * Telegram `reply_markup` options we support. The wire format is the same
 * shape Telegram expects, so the value is forwarded unchanged.
 */
export type TelegramReplyMarkup =
  | { inline_keyboard: InlineKeyboardButton[][] }
  | {
      force_reply: true;
      selective?: boolean;
      input_field_placeholder?: string;
    };

export interface TelegramMessageOptions {
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  disableWebPagePreview?: boolean;
  replyMarkup?: TelegramReplyMarkup;
}

/**
 * Send a text message to a Telegram chat.
 * Returns the message_id of the sent message (useful for later editing).
 */
export async function sendMessage(
  chatId: number | string,
  text: string,
  options?: TelegramMessageOptions,
  token: string = defaultBotToken()
): Promise<number | undefined> {
  const res = await fetch(apiUrlFor(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: options?.parseMode,
      disable_web_page_preview: options?.disableWebPagePreview,
      ...(options?.replyMarkup && { reply_markup: options.replyMarkup }),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[Telegram] sendMessage failed (${res.status}):`, body);
    return undefined;
  }

  const data = (await res.json()) as { ok: boolean; result?: { message_id?: number } };
  return data.result?.message_id;
}

/**
 * Edit an existing text message in a Telegram chat.
 * Logs errors but never throws — safe for fire-and-forget use.
 */
export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  options?: TelegramMessageOptions,
  token: string = defaultBotToken()
): Promise<void> {
  try {
    const res = await fetch(apiUrlFor(token, 'editMessageText'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: options?.parseMode,
        disable_web_page_preview: options?.disableWebPagePreview,
        ...(options?.replyMarkup && { reply_markup: options.replyMarkup }),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[Telegram] editMessageText failed (${res.status}):`, body);
    }
  } catch (err) {
    console.error('[Telegram] editMessageText error:', err);
  }
}

/**
 * Send a photo message to a Telegram chat.
 * Returns the message_id of the sent message.
 */
export async function sendPhoto(
  chatId: number | string,
  photoUrl: string,
  options?: TelegramMessageOptions & { caption?: string },
  token: string = defaultBotToken()
): Promise<number | undefined> {
  const res = await fetch(apiUrlFor(token, 'sendPhoto'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      photo: photoUrl,
      ...(options?.caption && { caption: options.caption }),
      ...(options?.parseMode && { parse_mode: options.parseMode }),
      ...(options?.replyMarkup && { reply_markup: options.replyMarkup }),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[Telegram] sendPhoto failed (${res.status}):`, body);
    return undefined;
  }

  const data = (await res.json()) as { ok: boolean; result?: { message_id?: number } };
  return data.result?.message_id;
}

/**
 * Delete a message from a Telegram chat.
 * Logs errors but never throws — safe for fire-and-forget use.
 */
export async function deleteMessage(
  chatId: number | string,
  messageId: number,
  token: string = defaultBotToken()
): Promise<void> {
  try {
    const res = await fetch(apiUrlFor(token, 'deleteMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[Telegram] deleteMessage failed (${res.status}):`, body);
    }
  } catch (err) {
    console.error('[Telegram] deleteMessage error:', err);
  }
}

/**
 * Edit the caption of a media message (photo, video, etc.) in a Telegram chat.
 * Logs errors but never throws — safe for fire-and-forget use.
 */
export async function editMessageCaption(
  chatId: number | string,
  messageId: number,
  caption: string,
  options?: TelegramMessageOptions,
  token: string = defaultBotToken()
): Promise<void> {
  try {
    const res = await fetch(apiUrlFor(token, 'editMessageCaption'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        caption,
        ...(options?.parseMode && { parse_mode: options.parseMode }),
        ...(options?.replyMarkup && { reply_markup: options.replyMarkup }),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[Telegram] editMessageCaption failed (${res.status}):`, body);
    }
  } catch (err) {
    console.error('[Telegram] editMessageCaption error:', err);
  }
}

/**
 * Edit only the inline keyboard (reply_markup) of an existing message.
 * Useful when a callback handler wants to update buttons without touching the text.
 */
export async function editMessageReplyMarkup(
  chatId: number | string,
  messageId: number,
  replyMarkup: { inline_keyboard: InlineKeyboardButton[][] } | null,
  token: string = defaultBotToken()
): Promise<void> {
  try {
    const res = await fetch(apiUrlFor(token, 'editMessageReplyMarkup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        ...(replyMarkup && { reply_markup: replyMarkup }),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[Telegram] editMessageReplyMarkup failed (${res.status}):`, body);
    }
  } catch (err) {
    console.error('[Telegram] editMessageReplyMarkup error:', err);
  }
}

/**
 * Acknowledge a callback_query (inline-button tap). Telegram requires this
 * within ~30s or the button shows a loading spinner indefinitely. Optional
 * `text` shows a toast/alert to the user.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  options?: { text?: string; showAlert?: boolean },
  token: string = defaultBotToken()
): Promise<void> {
  try {
    const res = await fetch(apiUrlFor(token, 'answerCallbackQuery'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        ...(options?.text && { text: options.text }),
        ...(options?.showAlert && { show_alert: options.showAlert }),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[Telegram] answerCallbackQuery failed (${res.status}):`, body);
    }
  } catch (err) {
    console.error('[Telegram] answerCallbackQuery error:', err);
  }
}

interface TelegramFileResponse {
  ok: boolean;
  result?: { file_path?: string };
}

/**
 * Get the download URL for a Telegram file by file_id.
 */
export async function getFileUrl(
  fileId: string,
  token: string = defaultBotToken()
): Promise<string> {
  const res = await fetch(apiUrlFor(token, 'getFile'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });

  if (!res.ok) {
    throw new Error(`getFile failed: ${res.status}`);
  }

  const data = (await res.json()) as TelegramFileResponse;
  const filePath = data.result?.file_path;
  if (!filePath) {
    throw new Error('No file_path in getFile response');
  }

  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

/**
 * Download a Telegram photo and return it as a base64 data URL.
 * Picks the appropriate MIME type from the file extension.
 */
export async function downloadPhotoAsDataUrl(
  fileId: string,
  token: string = defaultBotToken()
): Promise<string> {
  const url = await getFileUrl(fileId, token);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  // Determine MIME type from URL extension
  const ext = url.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  const mimeType = (ext && mimeTypes[ext]) || 'image/jpeg';

  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * Returns a Telegram client bound to a specific bot token. Use for the
 * Topics bot, which has its own token. The existing named exports default
 * to `TELEGRAM_API_SECRET` and remain unchanged for the News bot.
 */
export function createTelegramBotApi(token: string) {
  return {
    sendMessage: (chatId: number | string, text: string, options?: TelegramMessageOptions) =>
      sendMessage(chatId, text, options, token),
    sendPhoto: (
      chatId: number | string,
      photoUrl: string,
      options?: TelegramMessageOptions & { caption?: string }
    ) => sendPhoto(chatId, photoUrl, options, token),
    editMessageText: (
      chatId: number | string,
      messageId: number,
      text: string,
      options?: TelegramMessageOptions
    ) => editMessageText(chatId, messageId, text, options, token),
    editMessageCaption: (
      chatId: number | string,
      messageId: number,
      caption: string,
      options?: TelegramMessageOptions
    ) => editMessageCaption(chatId, messageId, caption, options, token),
    editMessageReplyMarkup: (
      chatId: number | string,
      messageId: number,
      replyMarkup: { inline_keyboard: InlineKeyboardButton[][] } | null
    ) => editMessageReplyMarkup(chatId, messageId, replyMarkup, token),
    deleteMessage: (chatId: number | string, messageId: number) =>
      deleteMessage(chatId, messageId, token),
    answerCallbackQuery: (
      callbackQueryId: string,
      options?: { text?: string; showAlert?: boolean }
    ) => answerCallbackQuery(callbackQueryId, options, token),
    getFileUrl: (fileId: string) => getFileUrl(fileId, token),
    downloadPhotoAsDataUrl: (fileId: string) => downloadPhotoAsDataUrl(fileId, token),
  };
}
