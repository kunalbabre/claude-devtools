/**
 * Metadata extraction utilities for parsing first messages and session context from JSONL files.
 */

import { isCommandOutputContent, sanitizeDisplayContent } from '@shared/utils/contentSanitizer';
import { createLogger } from '@shared/utils/logger';
import * as readline from 'readline';

import { LocalFileSystemProvider } from '../services/infrastructure/LocalFileSystemProvider';
import { type ChatHistoryEntry, isTextContent, type UserEntry } from '../types';

import type { FileSystemProvider } from '../services/infrastructure/FileSystemProvider';

const logger = createLogger('Util:metadataExtraction');

const defaultProvider = new LocalFileSystemProvider();

interface MessagePreview {
  text: string;
  timestamp: string;
  isCommand: boolean;
}

/**
 * Extract CWD (current working directory) from the first entry.
 * Used to get the actual project path from encoded directory names.
 */
export async function extractCwd(
  filePath: string,
  fsProvider: FileSystemProvider = defaultProvider
): Promise<string | null> {
  if (!(await fsProvider.exists(filePath))) {
    return null;
  }

  const fileStream = fsProvider.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      const entry = JSON.parse(line) as ChatHistoryEntry;
      // Only conversational entries have cwd
      if ('cwd' in entry && entry.cwd) {
        rl.close();
        fileStream.destroy();
        return entry.cwd;
      }
    }
  } catch (error) {
    logger.error(`Error extracting cwd from ${filePath}:`, error);
  } finally {
    rl.close();
    fileStream.destroy();
  }

  return null;
}

/**
 * Extract a lightweight title preview from the first user message.
 * For command-style sessions, falls back to a slash-command label.
 */
export async function extractFirstUserMessagePreview(
  filePath: string,
  fsProvider: FileSystemProvider = defaultProvider,
  maxLines: number = 200
): Promise<{ text: string; timestamp: string } | null> {
  const safeMaxLines = Math.max(1, maxLines);
  const fileStream = fsProvider.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let commandFallback: { text: string; timestamp: string } | null = null;
  let assistantFallback: { text: string; timestamp: string } | null = null;
  let sessionFallback: { text: string; timestamp: string } | null = null;
  let linesRead = 0;

  try {
    for await (const line of rl) {
      if (linesRead++ >= safeMaxLines) {
        break;
      }

      const trimmed = line.trim();
      if (!trimmed) continue;

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      // Handle Copilot event format: {type: "user.message", data: {content: "..."}}
      if (typeof raw.type === 'string' && (raw.type as string).includes('.')) {
        const evtType = raw.type as string;
        const data = raw.data as Record<string, unknown> | undefined;
        const copilotTs = (typeof raw.timestamp === 'string' ? raw.timestamp : null)
          ?? (data && typeof data.timestamp === 'string' ? data.timestamp : null)
          ?? new Date().toISOString();

        // Extract content from common fields
        const copilotContent = data
          ? (typeof data.content === 'string' ? data.content.trim() : null)
            ?? (typeof data.text === 'string' ? data.text.trim() : null)
            ?? (typeof data.message === 'string' ? data.message.trim() : null)
            ?? (typeof data.prompt === 'string' ? data.prompt.trim() : null)
          : null;

        // User messages: user.message, user.request, user.prompt, etc.
        if (evtType.startsWith('user.') && copilotContent && copilotContent.length > 0) {
          return { text: copilotContent.substring(0, 500), timestamp: copilotTs };
        }

        // Assistant messages as fallback
        if (evtType.startsWith('assistant.') && evtType !== 'assistant.message_delta'
          && !assistantFallback && copilotContent && copilotContent.length > 0) {
          assistantFallback = { text: copilotContent.substring(0, 500), timestamp: copilotTs };
        }

        // session.start: extract producer/title as session metadata fallback
        if (evtType === 'session.start' && data && !sessionFallback) {
          const title = typeof data.title === 'string' ? data.title : null;
          const name = typeof data.name === 'string' ? data.name : null;
          const producer = typeof data.producer === 'string' ? data.producer : null;
          const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
          const label = title ?? name ?? (producer ? `${producer} session` : null)
            ?? (sessionId ? `Session ${sessionId.substring(0, 8)}` : null);
          if (label) {
            sessionFallback = { text: label, timestamp: copilotTs };
          }
        }

        continue;
      }

      const entry = raw as unknown as ChatHistoryEntry;

      if (entry.type === 'user') {
        const preview = extractPreviewFromUserEntry(entry);
        if (!preview) {
          continue;
        }

        if (!preview.isCommand) {
          return { text: preview.text, timestamp: preview.timestamp };
        }

        if (!commandFallback) {
          commandFallback = { text: preview.text, timestamp: preview.timestamp };
        }
      } else if (entry.type === 'assistant' && !assistantFallback) {
        // Fallback: extract first assistant text response as potential title
        const content = entry.message?.content;
        if (Array.isArray(content)) {
          const textContent = content
            .filter(isTextContent)
            .map((b: { text: string }) => b.text)
            .join(' ')
            .trim();
          if (textContent.length > 0) {
            const sanitized = sanitizeDisplayContent(textContent);
            if (sanitized.length > 0) {
              assistantFallback = {
                text: sanitized.substring(0, 500),
                timestamp: entry.timestamp ?? new Date().toISOString(),
              };
            }
          }
        }
      }
    }
  } catch (error) {
    logger.debug(`Error extracting first user preview from ${filePath}:`, error);
    throw error;
  } finally {
    rl.close();
    fileStream.destroy();
  }

  return commandFallback ?? assistantFallback ?? sessionFallback;
}

function extractPreviewFromUserEntry(entry: UserEntry): MessagePreview | null {
  const timestamp = entry.timestamp ?? new Date().toISOString();
  const message = entry.message;
  if (!message) {
    return null;
  }

  const content = message.content;
  if (typeof content === 'string') {
    if (isCommandOutputContent(content) || content.startsWith('[Request interrupted by user')) {
      return null;
    }

    if (content.startsWith('<command-name>')) {
      return {
        text: extractCommandName(content),
        timestamp,
        isCommand: true,
      };
    }

    const sanitized = sanitizeDisplayContent(content).trim();
    if (!sanitized) {
      return null;
    }

    return {
      text: sanitized.substring(0, 500),
      timestamp,
      isCommand: false,
    };
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const textContent = content
    .filter(isTextContent)
    .map((block) => block.text)
    .join(' ')
    .trim();
  if (!textContent || textContent.startsWith('[Request interrupted by user')) {
    return null;
  }

  if (textContent.startsWith('<command-name>')) {
    return {
      text: extractCommandName(textContent),
      timestamp,
      isCommand: true,
    };
  }

  const sanitized = sanitizeDisplayContent(textContent).trim();
  if (!sanitized) {
    return null;
  }

  return {
    text: sanitized.substring(0, 500),
    timestamp,
    isCommand: false,
  };
}

function extractCommandName(content: string): string {
  const commandMatch = /<command-name>\/([^<]+)<\/command-name>/.exec(content);
  return commandMatch ? `/${commandMatch[1]}` : '/command';
}
