import { beforeEach, describe, expect, it } from 'vitest';

import {
  formatModifierShortcut,
  getModifierKeyName,
  getModifierKeySymbol,
  isMacOS,
} from '../../../src/renderer/utils/keyboardUtils';

describe('keyboardUtils', () => {
  describe('isMacOS', () => {
    beforeEach(() => {
      // Reset userAgent before each test
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: '',
      });
    });

    it('should return true when userAgent contains "mac"', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      });
      expect(isMacOS()).toBe(true);
    });

    it('should return false when userAgent does not contain "mac"', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      });
      expect(isMacOS()).toBe(false);
    });

    it('should be case-insensitive', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (MAC OS)',
      });
      expect(isMacOS()).toBe(true);
    });
  });

  describe('getModifierKeyName', () => {
    it('should return "Cmd" on macOS', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      });
      expect(getModifierKeyName()).toBe('Cmd');
    });

    it('should return "Ctrl" on Windows', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      });
      expect(getModifierKeyName()).toBe('Ctrl');
    });

    it('should return "Ctrl" on Linux', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (X11; Linux x86_64)',
      });
      expect(getModifierKeyName()).toBe('Ctrl');
    });
  });

  describe('getModifierKeySymbol', () => {
    it('should return "⌘" on macOS', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      });
      expect(getModifierKeySymbol()).toBe('⌘');
    });

    it('should return "Ctrl" on Windows', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      });
      expect(getModifierKeySymbol()).toBe('Ctrl');
    });

    it('should return "Ctrl" on Linux', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (X11; Linux x86_64)',
      });
      expect(getModifierKeySymbol()).toBe('Ctrl');
    });
  });

  describe('formatModifierShortcut', () => {
    describe('macOS', () => {
      beforeEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
          writable: true,
          configurable: true,
          value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        });
      });

      it('should format with symbol by default', () => {
        expect(formatModifierShortcut('K')).toBe('⌘K');
      });

      it('should format with text when useSymbol is false', () => {
        expect(formatModifierShortcut('K', false)).toBe('Cmd+K');
      });

      it('should work with different keys', () => {
        expect(formatModifierShortcut('G')).toBe('⌘G');
        expect(formatModifierShortcut('S')).toBe('⌘S');
        expect(formatModifierShortcut('Enter')).toBe('⌘Enter');
      });
    });

    describe('Windows/Linux', () => {
      beforeEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
          writable: true,
          configurable: true,
          value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        });
      });

      it('should format with symbol by default', () => {
        expect(formatModifierShortcut('K')).toBe('Ctrl+K');
      });

      it('should format with text when useSymbol is false', () => {
        expect(formatModifierShortcut('K', false)).toBe('Ctrl+K');
      });

      it('should work with different keys', () => {
        expect(formatModifierShortcut('G')).toBe('Ctrl+G');
        expect(formatModifierShortcut('S')).toBe('Ctrl+S');
        expect(formatModifierShortcut('Enter')).toBe('Ctrl+Enter');
      });

      it('should always include + separator', () => {
        expect(formatModifierShortcut('K')).toContain('+');
        expect(formatModifierShortcut('K', false)).toContain('+');
      });
    });
  });
});
