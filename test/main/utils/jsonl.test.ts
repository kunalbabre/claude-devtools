import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  analyzeSessionFileMetadata,
  calculateMetrics,
  parseJsonlFile,
  parseJsonlLine,
} from '../../../src/main/utils/jsonl';
import type { ParsedMessage } from '../../../src/main/types';

// Helper to create a minimal ParsedMessage
function createMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    uuid: 'test-uuid',
    parentUuid: null,
    type: 'assistant',
    timestamp: new Date('2024-01-01T10:00:00Z'),
    content: '',
    isSidechain: false,
    isMeta: false,
    isCompactSummary: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

describe('jsonl', () => {
  describe('parsing compatibility', () => {
    it('parses Copilot-style role/content JSONL lines', () => {
      const line = JSON.stringify({
        role: 'assistant',
        content: 'Here is a response',
        timestamp: '2026-01-01T00:00:00.000Z',
        id: 'copilot-msg-1',
      });

      const parsed = parseJsonlLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe('assistant');
      expect(parsed?.content).toBe('Here is a response');
    });

    it('parses Copilot-style JSON transcript files', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-json-'));
      try {
        const filePath = path.join(tempDir, 'session.json');
        const transcript = {
          requests: [
            {
              prompt: 'How do I test this?',
              response: 'Use Vitest and assert the behavior.',
              timestamp: '2026-01-01T10:00:00.000Z',
              model: 'gpt-4.1',
            },
          ],
        };

        fs.writeFileSync(filePath, JSON.stringify(transcript), 'utf8');

        const messages = await parseJsonlFile(filePath);
        expect(messages).toHaveLength(2);
        expect(messages[0].type).toBe('user');
        expect(messages[1].type).toBe('assistant');
      } finally {
        try {
          fs.rmSync(tempDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          });
        } catch {
          // Best-effort cleanup
        }
      }
    });
  });

  describe('calculateMetrics', () => {
    it('should return empty metrics for empty messages array', () => {
      const result = calculateMetrics([]);
      expect(result.durationMs).toBe(0);
      expect(result.totalTokens).toBe(0);
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.messageCount).toBe(0);
    });

    it('should calculate total tokens from usage', () => {
      const messages = [
        createMessage({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
        }),
      ];

      const result = calculateMetrics(messages);
      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(50);
      expect(result.totalTokens).toBe(150);
    });

    it('should sum tokens across multiple messages', () => {
      const messages = [
        createMessage({
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        createMessage({
          usage: { input_tokens: 200, output_tokens: 100 },
        }),
      ];

      const result = calculateMetrics(messages);
      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(150);
      expect(result.totalTokens).toBe(450);
    });

    it('should handle cache tokens', () => {
      const messages = [
        createMessage({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 25,
            cache_creation_input_tokens: 10,
          },
        }),
      ];

      const result = calculateMetrics(messages);
      expect(result.cacheReadTokens).toBe(25);
      expect(result.cacheCreationTokens).toBe(10);
      expect(result.totalTokens).toBe(185); // 100 + 50 + 25 + 10
    });

    it('should calculate duration from timestamps', () => {
      const messages = [
        createMessage({ timestamp: new Date('2024-01-01T10:00:00Z') }),
        createMessage({ timestamp: new Date('2024-01-01T10:01:00Z') }),
        createMessage({ timestamp: new Date('2024-01-01T10:02:00Z') }),
      ];

      const result = calculateMetrics(messages);
      expect(result.durationMs).toBe(120000); // 2 minutes in ms
    });

    it('should count messages', () => {
      const messages = [createMessage(), createMessage(), createMessage()];

      const result = calculateMetrics(messages);
      expect(result.messageCount).toBe(3);
    });

    it('should handle messages without usage', () => {
      const messages = [
        createMessage({ type: 'user', content: 'Hello' }),
        createMessage({ type: 'system' }),
      ];

      const result = calculateMetrics(messages);
      expect(result.totalTokens).toBe(0);
      expect(result.messageCount).toBe(2);
    });

    it('should handle single message duration', () => {
      const messages = [createMessage({ timestamp: new Date('2024-01-01T10:00:00Z') })];

      const result = calculateMetrics(messages);
      expect(result.durationMs).toBe(0); // min === max
    });

    it('should handle undefined token values', () => {
      const messages = [
        createMessage({
          usage: {
            input_tokens: undefined as unknown as number,
            output_tokens: 50,
          },
        }),
      ];

      const result = calculateMetrics(messages);
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(50);
    });
  });

  describe('analyzeSessionFileMetadata', () => {
    it('should extract first message, count, ongoing state, and git branch in one pass', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-meta-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const lines = [
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            timestamp: '2026-01-01T00:00:00.000Z',
            gitBranch: 'feature/test',
            message: { role: 'user', content: 'hello world' },
            isMeta: false,
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'a1',
            timestamp: '2026-01-01T00:00:01.000Z',
            message: {
              role: 'assistant',
              content: [{ type: 'thinking', thinking: 'thinking...' }],
            },
          }),
        ];
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

        const result = await analyzeSessionFileMetadata(filePath);

        expect(result.firstUserMessage?.text).toBe('hello world');
        expect(result.firstUserMessage?.timestamp).toBe('2026-01-01T00:00:00.000Z');
        expect(result.messageCount).toBe(2);
        expect(result.isOngoing).toBe(true);
        expect(result.gitBranch).toBe('feature/test');
      } finally {
        try {
          fs.rmSync(tempDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          });
        } catch {
          // Best-effort cleanup; ignore ENOTEMPTY on Windows when dir is in use
        }
      }
    });

    it('should extract title from agency session.start when no user message exists', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-agency-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const lines = [
          JSON.stringify({
            data: {
              copilotVersion: '0.0.375',
              producer: 'agency',
              sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
              startTime: '2026-01-17T15:21:19.143Z',
              version: 1,
            },
            id: '11111111-2222-3333-4444-555555555555',
            parentId: null,
            timestamp: '2026-01-17T15:21:19.143Z',
            type: 'session.start',
          }),
          JSON.stringify({
            data: { message: 'Session shutting down' },
            id: 'shutdown-1',
            timestamp: '2026-01-17T15:25:00.000Z',
            type: 'session.shutdown',
          }),
        ];
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

        const result = await analyzeSessionFileMetadata(filePath);

        expect(result.firstUserMessage?.text).toBe('agency session');
        expect(result.firstUserMessage?.timestamp).toBe('2026-01-17T15:21:19.143Z');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    });

    it('should extract user.message content for agency Copilot SDK events', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-agency-user-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const lines = [
          JSON.stringify({
            data: { producer: 'agency', sessionId: 'sid-1' },
            id: 'ev1',
            timestamp: '2026-01-17T15:21:19.143Z',
            type: 'session.start',
          }),
          JSON.stringify({
            data: { content: 'Build a REST API for user management' },
            id: 'ev2',
            timestamp: '2026-01-17T15:21:20.000Z',
            type: 'user.message',
          }),
          JSON.stringify({
            data: { content: 'I will create the REST API with Express.js.' },
            id: 'ev3',
            timestamp: '2026-01-17T15:21:25.000Z',
            type: 'assistant.message',
          }),
        ];
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

        const result = await analyzeSessionFileMetadata(filePath);

        expect(result.firstUserMessage?.text).toBe('Build a REST API for user management');
        expect(result.messageCount).toBe(1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    });

    it('should fall back to assistant.message when no user.message in Copilot events', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-agency-assist-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const lines = [
          JSON.stringify({
            data: { producer: 'agency', sessionId: 'sid-2' },
            id: 'ev1',
            timestamp: '2026-01-17T15:21:19.143Z',
            type: 'session.start',
          }),
          JSON.stringify({
            data: { content: 'Starting analysis of the codebase...' },
            id: 'ev3',
            timestamp: '2026-01-17T15:21:25.000Z',
            type: 'assistant.message',
          }),
        ];
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

        const result = await analyzeSessionFileMetadata(filePath);

        // Should use assistant message as fallback instead of "agency session" from session.start
        expect(result.firstUserMessage?.text).toBe('Starting analysis of the codebase...');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    });

    it('should count totalConversationalEntries for Copilot events', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-agency-count-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const lines = [
          JSON.stringify({
            data: { producer: 'agency', sessionId: 'sid-3' },
            id: 'ev1',
            timestamp: '2026-01-17T15:21:19.143Z',
            type: 'session.start',
          }),
          JSON.stringify({
            data: { content: '' },
            id: 'ev2',
            timestamp: '2026-01-17T15:21:20.000Z',
            type: 'user.message',
          }),
          JSON.stringify({
            data: { content: 'Response text' },
            id: 'ev3',
            timestamp: '2026-01-17T15:21:25.000Z',
            type: 'assistant.message',
          }),
        ];
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

        const result = await analyzeSessionFileMetadata(filePath);

        // messageCount=0 (user.message has empty content), but totalConversationalEntries=1 (assistant)
        // The return uses totalConversationalEntries as fallback
        expect(result.messageCount).toBe(1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    });

    it('should mark Copilot session as not ongoing after session.shutdown', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-agency-shutdown-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const lines = [
          JSON.stringify({
            data: { producer: 'agency', sessionId: 'sid-shutdown' },
            id: 'ev1',
            timestamp: '2026-01-17T15:21:19.143Z',
            type: 'session.start',
          }),
          JSON.stringify({
            data: { toolName: 'Read', input: { file: 'README.md' } },
            id: 'ev2',
            timestamp: '2026-01-17T15:21:20.000Z',
            type: 'tool.execution_start',
          }),
          JSON.stringify({
            data: { message: 'Session shutting down' },
            id: 'ev3',
            timestamp: '2026-01-17T15:21:21.000Z',
            type: 'session.shutdown',
          }),
        ];
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

        const result = await analyzeSessionFileMetadata(filePath);
        expect(result.isOngoing).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    });

    it('should treat assistant.response as ending output in Copilot events', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-agency-assistant-response-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const lines = [
          JSON.stringify({
            data: { producer: 'agency', sessionId: 'sid-assistant-response' },
            id: 'ev1',
            timestamp: '2026-01-17T15:21:19.143Z',
            type: 'session.start',
          }),
          JSON.stringify({
            data: { toolName: 'Read', input: { file: 'README.md' } },
            id: 'ev2',
            timestamp: '2026-01-17T15:21:20.000Z',
            type: 'tool.execution_start',
          }),
          JSON.stringify({
            data: { content: 'Completed analysis.' },
            id: 'ev3',
            timestamp: '2026-01-17T15:21:21.000Z',
            type: 'assistant.response',
          }),
        ];
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

        const result = await analyzeSessionFileMetadata(filePath);
        expect(result.isOngoing).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    });

    it('should handle unknown Copilot event types with content via prefix matching', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-agency-unknown-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const lines = [
          JSON.stringify({
            data: { producer: 'agency', sessionId: 'sid-4' },
            id: 'ev1',
            timestamp: '2026-01-17T15:21:19.143Z',
            type: 'session.start',
          }),
          JSON.stringify({
            data: { content: 'What is the meaning of life?' },
            id: 'ev2',
            timestamp: '2026-01-17T15:21:20.000Z',
            type: 'user.request',
          }),
        ];
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

        const result = await analyzeSessionFileMetadata(filePath);

        // user.request should be handled by user.* prefix matching
        expect(result.firstUserMessage?.text).toBe('What is the meaning of life?');
        expect(result.messageCount).toBe(1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    });
  });

  describe('parseJsonlLine - Copilot SDK event format', () => {
    it('should parse session.start events', () => {
      const line = JSON.stringify({
        data: {
          copilotVersion: '0.0.375',
          producer: 'agency',
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          startTime: '2026-01-17T15:21:19.143Z',
          version: 1,
        },
        id: '11111111-2222-3333-4444-555555555555',
        parentId: null,
        timestamp: '2026-01-17T15:21:19.143Z',
        type: 'session.start',
      });

      const parsed = parseJsonlLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe('system');
      expect(parsed?.content).toContain('Session started');
    });

    it('should parse unknown event types with content via fallback', () => {
      const line = JSON.stringify({
        data: { content: 'Design a database schema' },
        id: 'ev-unknown',
        timestamp: '2026-01-17T15:22:00.000Z',
        type: 'user.request',
      });

      const parsed = parseJsonlLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe('user');
      expect(parsed?.content).toBe('Design a database schema');
    });

    it('should parse agent.* event types as assistant messages', () => {
      const line = JSON.stringify({
        data: { content: 'Analyzing your codebase...' },
        id: 'ev-agent',
        timestamp: '2026-01-17T15:22:00.000Z',
        type: 'agent.response',
      });

      const parsed = parseJsonlLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe('assistant');
    });
  });});