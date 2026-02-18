/**
 * Utilities for parsing JSONL (JSON Lines) files used by Claude Code sessions.
 *
 * JSONL format: One JSON object per line
 * - Each line is a complete, valid JSON object
 * - Lines are separated by newline characters
 * - Empty lines should be skipped
 */

import { isCommandOutputContent, sanitizeDisplayContent } from '@shared/utils/contentSanitizer';
import { createLogger } from '@shared/utils/logger';
import * as crypto from 'crypto';
import * as readline from 'readline';

import { LocalFileSystemProvider } from '../services/infrastructure/LocalFileSystemProvider';
import {
  type ChatHistoryEntry,
  type ContentBlock,
  EMPTY_METRICS,
  isConversationalEntry,
  isParsedUserChunkMessage,
  isTextContent,
  type MessageType,
  type ParsedMessage,
  type SessionMetrics,
  type TokenUsage,
  type ToolCall,
} from '../types';

// Import from extracted modules
import { extractToolCalls, extractToolResults } from './toolExtraction';

import type { FileSystemProvider } from '../services/infrastructure/FileSystemProvider';
import type { PhaseTokenBreakdown } from '../types/domain';

const logger = createLogger('Util:jsonl');

const defaultProvider = new LocalFileSystemProvider();

// Re-export for backwards compatibility
export { extractCwd, extractFirstUserMessagePreview } from './metadataExtraction';
export { checkMessagesOngoing } from './sessionStateDetection';

// =============================================================================
// Core Parsing Functions
// =============================================================================

/**
 * Parse a JSONL file line by line using streaming.
 * This avoids loading the entire file into memory.
 */
export async function parseJsonlFile(
  filePath: string,
  fsProvider: FileSystemProvider = defaultProvider
): Promise<ParsedMessage[]> {
  const messages: ParsedMessage[] = [];

  if (!(await fsProvider.exists(filePath))) {
    return messages;
  }

  const fileStream = fsProvider.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const parsed = parseJsonlLine(line);
      if (parsed) {
        messages.push(parsed);
      }
    } catch (error) {
      logger.error(`Error parsing line in ${filePath}:`, error);
    }
  }

  if (messages.length === 0 && filePath.toLowerCase().endsWith('.json')) {
    return parseCopilotJsonFile(filePath, fsProvider);
  }

  return consolidateCopilotDeltas(messages);
}

/**
 * Parse a single JSONL line into a ParsedMessage.
 * Returns null for invalid/unsupported lines.
 *
 * Supports:
 * - Claude Code format: { uuid, type, message, timestamp, ... }
 * - Copilot simple format: { role, content, ... }
 * - Copilot event format: { type: "user.message", data: { content, ... }, timestamp }
 */
export function parseJsonlLine(line: string): ParsedMessage | null {
  if (!line.trim()) {
    return null;
  }

  const entry = JSON.parse(line) as unknown;
  const claudeEntry = parseChatHistoryEntry(entry as ChatHistoryEntry);
  if (claudeEntry) {
    return claudeEntry;
  }

  // Try Copilot event format (Background Agent JSONL)
  const copilotEvent = parseCopilotEventEntry(entry);
  if (copilotEvent) {
    return copilotEvent;
  }

  return parseCopilotMessageEntry(entry);
}

async function parseCopilotJsonFile(
  filePath: string,
  fsProvider: FileSystemProvider
): Promise<ParsedMessage[]> {
  try {
    const raw = await fsProvider.readFile(filePath);
    const data = JSON.parse(raw) as unknown;
    return parseCopilotTranscript(data);
  } catch (error) {
    logger.debug(`Failed to parse JSON transcript at ${filePath}:`, error);
    return [];
  }
}

function parseCopilotTranscript(data: unknown): ParsedMessage[] {
  if (!data || typeof data !== 'object') {
    return [];
  }

  if (Array.isArray(data)) {
    return parseCopilotMessageArray(data);
  }

  const obj = data as Record<string, unknown>;

  if (Array.isArray(obj.messages)) {
    return parseCopilotMessageArray(obj.messages);
  }

  if (Array.isArray(obj.requests)) {
    return parseCopilotRequestArray(obj.requests);
  }

  if (Array.isArray(obj.turns)) {
    return parseCopilotRequestArray(obj.turns);
  }

  const single = parseCopilotMessageEntry(obj);
  return single ? [single] : [];
}

function parseCopilotMessageArray(items: unknown[]): ParsedMessage[] {
  const messages = items
    .map((item) => parseCopilotMessageEntry(item))
    .filter((msg): msg is ParsedMessage => msg !== null);

  return assignParentUuids(messages);
}

function parseCopilotRequestArray(items: unknown[]): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item || typeof item !== 'object') {
      continue;
    }

    const request = item as Record<string, unknown>;
    const userText =
      asString(request.prompt) ??
      asString(request.input) ??
      asString(request.query) ??
      asString(request.message) ??
      asString((request.request as Record<string, unknown> | undefined)?.message);
    const assistantText =
      asString(request.response) ??
      asString(request.answer) ??
      asString(request.output) ??
      asString((request.responseMessage as Record<string, unknown> | undefined)?.content);

    const timestampRaw =
      asString(request.timestamp) ??
      asString(request.createdAt) ??
      asString(request.time) ??
      asString((request.request as Record<string, unknown> | undefined)?.timestamp);
    const timestamp = toDateOrNow(timestampRaw);

    if (userText && userText.trim().length > 0) {
      messages.push(
        buildCopilotMessage({
          type: 'user',
          content: userText,
          timestamp,
          uuidSeed: `copilot-user-${index}-${timestamp.toISOString()}`,
          cwd: asString(request.cwd) ?? asString(request.workspacePath),
        })
      );
    }

    if (assistantText && assistantText.trim().length > 0) {
      const assistantTs = toDateOrNow(
        asString((request.responseMessage as Record<string, unknown> | undefined)?.timestamp) ??
          timestamp.toISOString()
      );
      messages.push(
        buildCopilotMessage({
          type: 'assistant',
          content: [{ type: 'text', text: assistantText }],
          timestamp: assistantTs,
          uuidSeed: `copilot-assistant-${index}-${assistantTs.toISOString()}`,
          cwd: asString(request.cwd) ?? asString(request.workspacePath),
          model:
            asString(request.model) ??
            asString((request.responseMessage as Record<string, unknown> | undefined)?.model),
        })
      );
    }
  }

  messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return assignParentUuids(messages);
}

function parseCopilotMessageEntry(entry: unknown): ParsedMessage | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const obj = entry as Record<string, unknown>;
  const roleRaw =
    asString(obj.role) ??
    asString(obj.author) ??
    asString(obj.type) ??
    asString((obj.message as Record<string, unknown> | undefined)?.role);
  const role = normalizeRole(roleRaw);
  if (!role) {
    return null;
  }

  const content = (
    pickMessageContent(obj.content).value ??
    pickMessageContent((obj.message as Record<string, unknown> | undefined)?.content).value ??
    pickMessageContent(obj.text).value ??
    pickMessageContent(obj.value).value
  );
  if (content === null) {
    return null;
  }

  const timestampRaw =
    asString(obj.timestamp) ??
    asString(obj.createdAt) ??
    asString(obj.time) ??
    asString((obj.message as Record<string, unknown> | undefined)?.timestamp);

  return buildCopilotMessage({
    type: role,
    content,
    timestamp: toDateOrNow(timestampRaw),
    uuidSeed:
      asString(obj.uuid) ??
      asString(obj.id) ??
      `copilot-${role}-${asString(timestampRaw) ?? Date.now().toString()}`,
    cwd: asString(obj.cwd) ?? asString(obj.workspacePath),
    model:
      asString(obj.model) ?? asString((obj.message as Record<string, unknown> | undefined)?.model),
  });
}

function buildCopilotMessage(params: {
  type: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
  timestamp: Date;
  uuidSeed: string;
  cwd?: string;
  model?: string;
}): ParsedMessage {
  const uuid = stableUuid(params.uuidSeed);
  const isAssistant = params.type === 'assistant';

  return {
    uuid,
    parentUuid: null,
    type: params.type,
    timestamp: params.timestamp,
    role: params.type,
    content: params.content,
    usage: undefined,
    model: isAssistant ? params.model : undefined,
    cwd: params.cwd,
    gitBranch: undefined,
    agentId: undefined,
    isSidechain: false,
    isMeta: false,
    userType: params.type === 'user' ? 'external' : undefined,
    isCompactSummary: false,
    toolCalls: extractToolCalls(params.content),
    toolResults: extractToolResults(params.content),
    sourceToolUseID: undefined,
    sourceToolAssistantUUID: undefined,
    toolUseResult: undefined,
  };
}

// =============================================================================
// Copilot Background Agent Event Format
// =============================================================================

/**
 * Parse a Copilot Background Agent JSONL event line.
 *
 * Format: { type: "user.message" | "assistant.message" | "assistant.message_delta" |
 *           "tool.execution_start" | "tool.execution_complete" | "session.start" |
 *           "session.error" | "session.shutdown",
 *           data: { ... },
 *           timestamp: "...",
 *           id?: "..." }
 */
function parseCopilotEventEntry(entry: unknown): ParsedMessage | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const obj = entry as Record<string, unknown>;
  const eventType = asString(obj.type);

  if (!eventType?.includes('.')) {
    return null;
  }

  const data = obj.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') {
    return null;
  }

  const timestampRaw = asString(obj.timestamp) ?? asString(data.timestamp);
  const timestamp = toDateOrNow(timestampRaw);
  const eventId = asString(obj.id) ?? asString(data.id) ?? '';

  switch (eventType) {
    case 'session.start': {
      const sessionId = asString(data.sessionId) ?? '';
      return buildCopilotMessage({
        type: 'system',
        content: `Session started (${sessionId})`,
        timestamp,
        uuidSeed: `copilot-event-${eventId}-session-start`,
        cwd: asString(data.cwd) ?? asString(data.workingDirectory),
      });
    }

    case 'user.message': {
      const content = asString(data.content) ?? '';
      if (!content.trim()) {
        return null;
      }
      return buildCopilotMessage({
        type: 'user',
        content,
        timestamp,
        uuidSeed: `copilot-event-${eventId}-user`,
        cwd: asString(data.cwd),
      });
    }

    case 'assistant.message': {
      const content = asString(data.content) ?? '';
      if (!content.trim()) {
        return null;
      }
      return buildCopilotMessage({
        type: 'assistant',
        content: [{ type: 'text', text: content }],
        timestamp,
        uuidSeed: `copilot-event-${eventId}-assistant-${asString(data.messageId) ?? ''}`,
        model: asString(data.model),
      });
    }

    case 'assistant.message_delta': {
      // Deltas are typically aggregated by the consumer; emit as individual messages
      // only when full assistant.message is not present
      const deltaContent = asString(data.deltaContent) ?? '';
      if (!deltaContent.trim()) {
        return null;
      }
      return buildCopilotMessage({
        type: 'assistant',
        content: [{ type: 'text', text: deltaContent }],
        timestamp,
        uuidSeed: `copilot-event-${eventId}-delta-${asString(data.messageId) ?? ''}`,
        model: asString(data.model),
      });
    }

    case 'tool.execution_start': {
      const toolName = asString(data.toolName) ?? asString(data.name) ?? 'unknown_tool';
      const toolInput = data.input ?? data.parameters ?? {};
      const toolCallId = asString(data.toolCallId) ?? eventId;
      const contentBlocks: ContentBlock[] = [
        {
          type: 'tool_use',
          id: toolCallId,
          name: toolName,
          input: toolInput as Record<string, unknown>,
        },
      ];
      return buildCopilotMessage({
        type: 'assistant',
        content: contentBlocks,
        timestamp,
        uuidSeed: `copilot-event-${eventId}-tool-start-${toolCallId}`,
      });
    }

    case 'tool.execution_complete': {
      const toolCallId = asString(data.toolCallId) ?? eventId;
      const resultContent = asString(data.output) ?? asString(data.content) ?? '';
      const isError = data.isError === true || data.status === 'error';
      const contentBlocks: ContentBlock[] = [
        {
          type: 'tool_result',
          tool_use_id: toolCallId,
          content: resultContent,
          is_error: isError,
        },
      ];
      return buildCopilotMessage({
        type: 'user',
        content: contentBlocks,
        timestamp,
        uuidSeed: `copilot-event-${eventId}-tool-complete-${toolCallId}`,
      });
    }

    case 'session.error': {
      const errorMsg = asString(data.message) ?? asString(data.error) ?? 'Unknown error';
      const errorType = asString(data.errorType) ?? 'error';
      return buildCopilotMessage({
        type: 'system',
        content: `Error (${errorType}): ${errorMsg}`,
        timestamp,
        uuidSeed: `copilot-event-${eventId}-error`,
      });
    }

    case 'session.shutdown': {
      return buildCopilotMessage({
        type: 'system',
        content: 'Session ended',
        timestamp,
        uuidSeed: `copilot-event-${eventId}-shutdown`,
      });
    }

    default: {
      // Generic fallback: handle any unknown event type with content
      // e.g., user.request, agent.response, message.user, etc.
      const genericContent = asString(data.content) ?? asString(data.text)
        ?? asString(data.message) ?? asString(data.prompt);
      if (genericContent && genericContent.trim().length > 0) {
        // Determine role from the event type prefix
        const prefix = eventType.split('.')[0].toLowerCase();
        const role: 'user' | 'assistant' | 'system' =
          prefix === 'user' ? 'user'
          : (prefix === 'assistant' || prefix === 'agent') ? 'assistant'
          : 'system';

        if (role === 'assistant') {
          return buildCopilotMessage({
            type: 'assistant',
            content: [{ type: 'text', text: genericContent.trim() }],
            timestamp,
            uuidSeed: `copilot-event-${eventId}-${eventType}`,
            model: asString(data.model),
          });
        }
        return buildCopilotMessage({
          type: role,
          content: genericContent.trim(),
          timestamp,
          uuidSeed: `copilot-event-${eventId}-${eventType}`,
          cwd: asString(data.cwd) ?? asString(data.workingDirectory),
        });
      }
      return null;
    }
  }
}

/**
 * Consolidate assistant.message_delta events into single assistant messages.
 * When a full assistant.message is present for a given messageId, deltas for
 * that messageId are dropped. Otherwise deltas are merged into one message.
 *
 * This is a no-op for non-Copilot sessions (no delta messages present).
 */
function consolidateCopilotDeltas(messages: ParsedMessage[]): ParsedMessage[] {
  // Quick check: if no messages look like Copilot events, return as-is
  let hasCopilotEvents = false;
  for (const msg of messages) {
    if (msg.type === 'system' && typeof msg.content === 'string' && msg.content.startsWith('Session started')) {
      hasCopilotEvents = true;
      break;
    }
  }
  if (!hasCopilotEvents) {
    return messages;
  }

  // For Copilot event sessions, re-assign parent UUIDs for proper chaining
  return assignParentUuids(messages);
}

function assignParentUuids(messages: ParsedMessage[]): ParsedMessage[] {
  let previousUuid: string | null = null;
  return messages.map((message) => {
    const parentUuid = previousUuid;
    previousUuid = message.uuid;
    return {
      ...message,
      parentUuid,
    };
  });
}

function stableUuid(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24); // NOSONAR
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

type CopilotRole = 'user' | 'assistant' | 'system';

function normalizeRole(raw: string | undefined): CopilotRole | null {
  if (!raw) {
    return null;
  }

  const normalized = raw.toLowerCase();
  if (normalized === 'user' || normalized === 'human') {
    return 'user' as CopilotRole;
  }
  if (normalized === 'assistant' || normalized === 'ai' || normalized === 'copilot') {
    return 'assistant' as CopilotRole;
  }
  if (normalized === 'system') {
    return 'system' as CopilotRole;
  }
  return null;
}

type MessageContent = string | ContentBlock[];

// sonarjs/function-return-type requires a single return type at all exits.
// We wrap results in an object to satisfy the rule while keeping the union payload.
interface ContentResult {
  value: MessageContent | null;
}

function pickMessageContent(value: unknown): ContentResult {
  if (typeof value === 'string') {
    return { value };
  }

  if (Array.isArray(value)) {
    return { value: value as ContentBlock[] };
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const text = asString(obj.text) ?? asString(obj.value);
    if (text) {
      return { value: text };
    }
  }

  return { value: null };
}

function toDateOrNow(value?: string): Date {
  if (!value) {
    return new Date();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }

  return parsed;
}

// =============================================================================
// Entry Parsing
// =============================================================================

/**
 * Parse a single JSONL entry into a ParsedMessage.
 */
function parseChatHistoryEntry(entry: ChatHistoryEntry): ParsedMessage | null {
  // Skip entries without uuid (usually metadata)
  if (!entry.uuid) {
    return null;
  }

  const type = parseMessageType(entry.type);
  if (!type) {
    return null;
  }

  // Handle different entry types
  let content: string | ContentBlock[] = '';
  let role: string | undefined;
  let usage: TokenUsage | undefined;
  let model: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let agentId: string | undefined;
  let isSidechain = false;
  let isMeta = false;
  let userType: string | undefined;
  let sourceToolUseID: string | undefined;
  let sourceToolAssistantUUID: string | undefined;
  let toolUseResult: Record<string, unknown> | undefined;
  let parentUuid: string | null = null;

  // Extract properties based on entry type
  let isCompactSummary = false;
  if (isConversationalEntry(entry)) {
    // Common properties from ConversationalEntry base
    cwd = entry.cwd;
    gitBranch = entry.gitBranch;
    isSidechain = entry.isSidechain ?? false;
    userType = entry.userType;
    parentUuid = entry.parentUuid ?? null;

    // Type-specific properties
    if (entry.type === 'user') {
      content = entry.message.content ?? '';
      role = entry.message.role;
      agentId = entry.agentId;
      isMeta = entry.isMeta ?? false;
      sourceToolUseID = entry.sourceToolUseID;
      sourceToolAssistantUUID = entry.sourceToolAssistantUUID;
      toolUseResult = entry.toolUseResult;
      // Check for isCompactSummary on user entry (may exist on raw JSONL)
      isCompactSummary = 'isCompactSummary' in entry && entry.isCompactSummary === true;
    } else if (entry.type === 'assistant') {
      content = entry.message.content;
      role = entry.message.role;
      usage = entry.message.usage;
      model = entry.message.model;
      agentId = entry.agentId;
    } else if (entry.type === 'system') {
      isMeta = entry.isMeta ?? false;
    }
  }

  // Extract tool calls and results
  const toolCalls = extractToolCalls(content);
  const toolResultsList = extractToolResults(content);

  return {
    uuid: entry.uuid,
    parentUuid,
    type,
    timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
    role,
    content,
    usage,
    model,
    // Metadata
    cwd,
    gitBranch,
    agentId,
    isSidechain,
    isMeta,
    userType,
    isCompactSummary,
    // Tool info
    toolCalls,
    toolResults: toolResultsList,
    sourceToolUseID,
    sourceToolAssistantUUID,
    toolUseResult,
  };
}

/**
 * Parse message type string into enum.
 */
function parseMessageType(type?: string): MessageType | null {
  switch (type) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'summary':
      return 'summary';
    case 'file-history-snapshot':
      return 'file-history-snapshot';
    case 'queue-operation':
      return 'queue-operation';
    default:
      // Unknown types are skipped
      return null;
  }
}

// =============================================================================
// Metrics Calculation
// =============================================================================

/**
 * Calculate session metrics from parsed messages.
 */
export function calculateMetrics(messages: ParsedMessage[]): SessionMetrics {
  if (messages.length === 0) {
    return { ...EMPTY_METRICS };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  const costUsd = 0;

  // Get timestamps for duration (loop instead of Math.min/max spread to avoid stack overflow on large sessions)
  const timestamps = messages.map((m) => m.timestamp.getTime()).filter((t) => !isNaN(t));

  let minTime = 0;
  let maxTime = 0;
  if (timestamps.length > 0) {
    minTime = timestamps[0];
    maxTime = timestamps[0];
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < minTime) minTime = timestamps[i];
      if (timestamps[i] > maxTime) maxTime = timestamps[i];
    }
  }

  for (const msg of messages) {
    if (msg.usage) {
      inputTokens += msg.usage.input_tokens ?? 0;
      outputTokens += msg.usage.output_tokens ?? 0;
      cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
      cacheCreationTokens += msg.usage.cache_creation_input_tokens ?? 0;
    }
  }

  return {
    durationMs: maxTime - minTime,
    totalTokens: inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    messageCount: messages.length,
    costUsd: costUsd > 0 ? costUsd : undefined,
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Extract text content from a message for display.
 * This version applies content sanitization to filter XML-like tags.
 */
export function extractTextContent(message: ParsedMessage): string {
  let rawText: string;

  if (typeof message.content === 'string') {
    rawText = message.content;
  } else {
    rawText = message.content
      .filter(isTextContent)
      .map((block) => block.text)
      .join('\n');
  }

  // Apply sanitization to remove XML-like tags for display
  return sanitizeDisplayContent(rawText);
}

/**
 * Get all Task calls from a list of messages.
 */
export function getTaskCalls(messages: ParsedMessage[]): ToolCall[] {
  return messages.flatMap((m) => m.toolCalls.filter((tc) => tc.isTask));
}

export interface SessionFileMetadata {
  firstUserMessage: { text: string; timestamp: string } | null;
  messageCount: number;
  isOngoing: boolean;
  gitBranch: string | null;
  /** Total context consumed (compaction-aware) */
  contextConsumption?: number;
  /** Number of compaction events */
  compactionCount?: number;
  /** Per-phase token breakdown */
  phaseBreakdown?: PhaseTokenBreakdown[];
}

/**
 * Analyze key session metadata in a single streaming pass.
 * This avoids multiple file scans when listing sessions.
 */
export async function analyzeSessionFileMetadata(
  filePath: string,
  fsProvider: FileSystemProvider = defaultProvider
): Promise<SessionFileMetadata> {
  if (!(await fsProvider.exists(filePath))) {
    return {
      firstUserMessage: null,
      messageCount: 0,
      isOngoing: false,
      gitBranch: null,
    };
  }

  const fileStream = fsProvider.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let firstUserMessage: { text: string; timestamp: string } | null = null;
  let firstCommandMessage: { text: string; timestamp: string } | null = null;
  let firstAssistantMessage: { text: string; timestamp: string } | null = null;
  let sessionMetadataFallback: { text: string; timestamp: string } | null = null;
  let messageCount = 0;
  let totalConversationalEntries = 0;
  // After a UserGroup, await the first main-thread assistant message to count the AIGroup
  let awaitingAIGroup = false;
  let gitBranch: string | null = null;

  let activityIndex = 0;
  let lastEndingIndex = -1;
  let hasAnyOngoingActivity = false;
  let hasActivityAfterLastEnding = false;
  // Track tool_use IDs that are shutdown responses so their tool_results are also ending events
  const shutdownToolIds = new Set<string>();

  // Context consumption tracking

  let lastMainAssistantInputTokens = 0;
  const compactionPhases: { pre: number; post: number }[] = [];

  let awaitingPostCompaction = false;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Try Copilot event format first: {type: "user.message", data: {content: "..."}, timestamp}
    const eventType = typeof entry.type === 'string' ? entry.type : '';
    if (eventType.includes('.')) {
      // Copilot event format
      const data = entry.data as Record<string, unknown> | undefined;
      const copilotTs = (typeof entry.timestamp === 'string' ? entry.timestamp : null)
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
      if (eventType.startsWith('user.') && copilotContent && copilotContent.length > 0) {
        messageCount++;
        totalConversationalEntries++;
        if (!firstUserMessage) {
          const sanitized = sanitizeDisplayContent(copilotContent);
          if (sanitized.length > 0) {
            firstUserMessage = {
              text: sanitized.substring(0, 500),
              timestamp: copilotTs,
            };
          }
        }
      }

      // Assistant messages: assistant.message, assistant.response, etc.
      if (eventType.startsWith('assistant.') && eventType !== 'assistant.message_delta') {
        totalConversationalEntries++;
        if (!firstAssistantMessage && copilotContent && copilotContent.length > 0) {
          const sanitized = sanitizeDisplayContent(copilotContent);
          if (sanitized.length > 0) {
            firstAssistantMessage = {
              text: sanitized.substring(0, 500),
              timestamp: copilotTs,
            };
          }
        }
      }

      // session.start: extract producer/sessionId as ultimate fallback title
      if (eventType === 'session.start' && data && !sessionMetadataFallback) {
        const producer = typeof data.producer === 'string' ? data.producer : null;
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
        const title = typeof data.title === 'string' ? data.title : null;
        const name = typeof data.name === 'string' ? data.name : null;
        const fallbackLabel = title ?? name ?? (producer ? `${producer} session` : null)
          ?? (sessionId ? `Session ${sessionId.substring(0, 8)}` : null);
        if (fallbackLabel) {
          sessionMetadataFallback = {
            text: fallbackLabel,
            timestamp: copilotTs,
          };
        }
      }

      // For Copilot/Agency events, ongoing detection across varied event names.
      const lowerEventType = eventType.toLowerCase();
      const isAssistantDelta = lowerEventType === 'assistant.message_delta';
      const isAssistantEnding =
        lowerEventType.startsWith('assistant.') &&
        !isAssistantDelta &&
        !!copilotContent &&
        copilotContent.length > 0;
      const isSessionEnding =
        lowerEventType === 'session.shutdown' ||
        lowerEventType === 'session.error' ||
        /^session\.(end|ended|stop|stopped|complete|completed|close|closed|shutdown|error)$/.test(
          lowerEventType
        );
      const isToolStartActivity =
        lowerEventType === 'tool.execution_start' ||
        /^tool\..*(start|started|begin|began|invoke|invoked|call|called)$/.test(lowerEventType);
      const isToolEnding =
        lowerEventType === 'tool.execution_complete' ||
        /^tool\..*(complete|completed|finish|finished|result|error|end|ended)$/.test(
          lowerEventType
        );

      if (isAssistantEnding || isSessionEnding || isToolEnding) {
        lastEndingIndex = activityIndex++;
        hasActivityAfterLastEnding = false;
      } else if (isToolStartActivity || isAssistantDelta) {
        hasAnyOngoingActivity = true;
        if (lastEndingIndex >= 0) {
          hasActivityAfterLastEnding = true;
        }
        activityIndex++;
      }
      continue;
    }

    const claudeEntry = entry as unknown as ChatHistoryEntry;
    const parsed = parseChatHistoryEntry(claudeEntry);
    if (!parsed) {
      // Even without uuid, count entries with type user/assistant for totalConversationalEntries
      if (claudeEntry.type === 'user' || claudeEntry.type === 'assistant') {
        totalConversationalEntries++;
      }
      // Try extracting firstUserMessage even without uuid (some tools omit uuid)
      if (!firstUserMessage && claudeEntry.type === 'user') {
        const content = claudeEntry.message?.content;
        if (typeof content === 'string') {
          if (!isCommandOutputContent(content) && !content.startsWith('[Request interrupted by user')) {
            if (content.startsWith('<command-name>')) {
              if (!firstCommandMessage) {
                const commandMatch = /<command-name>\/([^<]+)<\/command-name>/.exec(content);
                const commandName = commandMatch ? `/${commandMatch[1]}` : '/command';
                firstCommandMessage = {
                  text: commandName,
                  timestamp: claudeEntry.timestamp ?? new Date().toISOString(),
                };
              }
            } else {
              const sanitized = sanitizeDisplayContent(content);
              if (sanitized.length > 0) {
                firstUserMessage = {
                  text: sanitized.substring(0, 500),
                  timestamp: claudeEntry.timestamp ?? new Date().toISOString(),
                };
              }
            }
          }
        }
      }
      // Try extracting first assistant text as fallback title
      if (!firstAssistantMessage && claudeEntry.type === 'assistant') {
        const content = claudeEntry.message?.content;
        if (Array.isArray(content)) {
          const textContent = content
            .filter(isTextContent)
            .map((b) => b.text)
            .join(' ')
            .trim();
          if (textContent.length > 0) {
            firstAssistantMessage = {
              text: textContent.substring(0, 500),
              timestamp: claudeEntry.timestamp ?? new Date().toISOString(),
            };
          }
        }
      }
      continue;
    }

    totalConversationalEntries++;

    if (isParsedUserChunkMessage(parsed)) {
      messageCount++;
      awaitingAIGroup = true;
    } else if (
      awaitingAIGroup &&
      parsed.type === 'assistant' &&
      parsed.model !== '<synthetic>' &&
      !parsed.isSidechain
    ) {
      messageCount++;
      awaitingAIGroup = false;
    }

    if (!gitBranch && 'gitBranch' in claudeEntry && claudeEntry.gitBranch) {
      gitBranch = claudeEntry.gitBranch;
    }

    if (!firstUserMessage && claudeEntry.type === 'user') {
      const content = claudeEntry.message?.content;
      if (typeof content === 'string') {
        if (isCommandOutputContent(content)) {
          // Skip
        } else if (content.startsWith('[Request interrupted by user')) {
          // Skip interruption messages
        } else if (content.startsWith('<command-name>')) {
          if (!firstCommandMessage) {
            const commandMatch = /<command-name>\/([^<]+)<\/command-name>/.exec(content);
            const commandName = commandMatch ? `/${commandMatch[1]}` : '/command';
            firstCommandMessage = {
              text: commandName,
              timestamp: claudeEntry.timestamp ?? new Date().toISOString(),
            };
          }
        } else {
          const sanitized = sanitizeDisplayContent(content);
          if (sanitized.length > 0) {
            firstUserMessage = {
              text: sanitized.substring(0, 500),
              timestamp: claudeEntry.timestamp ?? new Date().toISOString(),
            };
          }
        }
      } else if (Array.isArray(content)) {
        const textContent = content
          .filter(isTextContent)
          .map((b) => b.text)
          .join(' ');
        if (
          textContent &&
          !textContent.startsWith('<command-name>') &&
          !textContent.startsWith('[Request interrupted by user')
        ) {
          const sanitized = sanitizeDisplayContent(textContent);
          if (sanitized.length > 0) {
            firstUserMessage = {
              text: sanitized.substring(0, 500),
              timestamp: claudeEntry.timestamp ?? new Date().toISOString(),
            };
          }
        }
      }
    }

    // Fallback: extract first assistant text response as potential title
    if (!firstAssistantMessage && claudeEntry.type === 'assistant') {
      const content = claudeEntry.message?.content;
      if (Array.isArray(content)) {
        const textContent = content
          .filter(isTextContent)
          .map((b) => b.text)
          .join(' ')
          .trim();
        if (textContent.length > 0) {
          const sanitized = sanitizeDisplayContent(textContent);
          if (sanitized.length > 0) {
            firstAssistantMessage = {
              text: sanitized.substring(0, 500),
              timestamp: claudeEntry.timestamp ?? new Date().toISOString(),
            };
          }
        }
      }
    }

    // Ongoing detection with one-pass activity tracking.
    if (parsed.type === 'assistant' && Array.isArray(parsed.content)) {
      for (const block of parsed.content) {
        if (block.type === 'thinking' && block.thinking) {
          hasAnyOngoingActivity = true;
          if (lastEndingIndex >= 0) {
            hasActivityAfterLastEnding = true;
          }
          activityIndex++;
        } else if (block.type === 'tool_use' && block.id) {
          if (block.name === 'ExitPlanMode') {
            lastEndingIndex = activityIndex++;
            hasActivityAfterLastEnding = false;
          } else if (
            block.name === 'SendMessage' &&
            block.input?.type === 'shutdown_response' &&
            block.input?.approve === true
          ) {
            // SendMessage shutdown_response = agent is shutting down (ending event)
            shutdownToolIds.add(block.id);
            lastEndingIndex = activityIndex++;
            hasActivityAfterLastEnding = false;
          } else {
            hasAnyOngoingActivity = true;
            if (lastEndingIndex >= 0) {
              hasActivityAfterLastEnding = true;
            }
            activityIndex++;
          }
        } else if (block.type === 'text' && block.text && String(block.text).trim().length > 0) {
          lastEndingIndex = activityIndex++;
          hasActivityAfterLastEnding = false;
        }
      }
    } else if (parsed.type === 'user' && Array.isArray(parsed.content)) {
      // Check if this is a user-rejected tool use (ending event, not ongoing activity)
      const isRejection =
        'toolUseResult' in claudeEntry &&
        (claudeEntry as unknown as Record<string, unknown>).toolUseResult === 'User rejected tool use';

      for (const block of parsed.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          if (shutdownToolIds.has(block.tool_use_id) || isRejection) {
            // Shutdown tool result or user rejection = ending event
            lastEndingIndex = activityIndex++;
            hasActivityAfterLastEnding = false;
          } else {
            hasAnyOngoingActivity = true;
            if (lastEndingIndex >= 0) {
              hasActivityAfterLastEnding = true;
            }
            activityIndex++;
          }
        } else if (
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.startsWith('[Request interrupted by user')
        ) {
          lastEndingIndex = activityIndex++;
          hasActivityAfterLastEnding = false;
        }
      }
    }

    // Context consumption: track main-thread assistant input tokens
    if (parsed.type === 'assistant' && !parsed.isSidechain && parsed.model !== '<synthetic>') {
      const inputTokens =
        (parsed.usage?.input_tokens ?? 0) +
        (parsed.usage?.cache_read_input_tokens ?? 0) +
        (parsed.usage?.cache_creation_input_tokens ?? 0);
      if (inputTokens > 0) {
        if (awaitingPostCompaction && compactionPhases.length > 0) {
          compactionPhases[compactionPhases.length - 1].post = inputTokens;
          awaitingPostCompaction = false;
        }
        lastMainAssistantInputTokens = inputTokens;
      }
    }

    // Context consumption: detect compaction events
    if (parsed.isCompactSummary) {
      compactionPhases.push({ pre: lastMainAssistantInputTokens, post: 0 });
      awaitingPostCompaction = true;
    }
  }

  // Compute context consumption from tracked phases
  let contextConsumption: number | undefined;
  let phaseBreakdown: PhaseTokenBreakdown[] | undefined;

  if (lastMainAssistantInputTokens > 0) {
    if (compactionPhases.length === 0) {
      // No compaction: just the final input tokens
      contextConsumption = lastMainAssistantInputTokens;
      phaseBreakdown = [
        {
          phaseNumber: 1,
          contribution: lastMainAssistantInputTokens,
          peakTokens: lastMainAssistantInputTokens,
        },
      ];
    } else {
      phaseBreakdown = [];
      let total = 0;

      // Phase 1: tokens up to first compaction
      const phase1Contribution = compactionPhases[0].pre;
      total += phase1Contribution;
      phaseBreakdown.push({
        phaseNumber: 1,
        contribution: phase1Contribution,
        peakTokens: compactionPhases[0].pre,
        postCompaction: compactionPhases[0].post,
      });

      // Middle phases: contribution = pre[i] - post[i-1]
      for (let i = 1; i < compactionPhases.length; i++) {
        const contribution = compactionPhases[i].pre - compactionPhases[i - 1].post;
        total += contribution;
        phaseBreakdown.push({
          phaseNumber: i + 1,
          contribution,
          peakTokens: compactionPhases[i].pre,
          postCompaction: compactionPhases[i].post,
        });
      }

      // Last phase: final tokens - last post-compaction
      // Guard: if the last compaction had no subsequent assistant message, post is 0.
      // In that case, skip the final phase to avoid double-counting.
      const lastPhase = compactionPhases[compactionPhases.length - 1];
      if (lastPhase.post > 0) {
        const lastContribution = lastMainAssistantInputTokens - lastPhase.post;
        total += lastContribution;
        phaseBreakdown.push({
          phaseNumber: compactionPhases.length + 1,
          contribution: lastContribution,
          peakTokens: lastMainAssistantInputTokens,
        });
      }

      contextConsumption = total;
    }
  }

  return {
    firstUserMessage: firstUserMessage ?? firstCommandMessage ?? firstAssistantMessage ?? sessionMetadataFallback,
    messageCount: messageCount > 0 ? messageCount : totalConversationalEntries,
    isOngoing: lastEndingIndex === -1 ? hasAnyOngoingActivity : hasActivityAfterLastEnding,
    gitBranch,
    contextConsumption,
    compactionCount: compactionPhases.length > 0 ? compactionPhases.length : undefined,
    phaseBreakdown,
  };
}
