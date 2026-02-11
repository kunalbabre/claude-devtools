/**
 * Store index - combines all slices and exports the unified store.
 */

import { create } from 'zustand';

import { createConfigSlice } from './slices/configSlice';
import { createConnectionSlice } from './slices/connectionSlice';
import { createConversationSlice } from './slices/conversationSlice';
import { createNotificationSlice } from './slices/notificationSlice';
import { createPaneSlice } from './slices/paneSlice';
import { createProjectSlice } from './slices/projectSlice';
import { createRepositorySlice } from './slices/repositorySlice';
import { createSessionDetailSlice } from './slices/sessionDetailSlice';
import { createSessionSlice } from './slices/sessionSlice';
import { createSubagentSlice } from './slices/subagentSlice';
import { createTabSlice } from './slices/tabSlice';
import { createTabUISlice } from './slices/tabUISlice';
import { createUISlice } from './slices/uiSlice';
import { createUpdateSlice } from './slices/updateSlice';

import type { DetectedError } from '../types/data';
import type { AppState } from './types';
import type { UpdaterStatus } from '@shared/types';

// =============================================================================
// Store Creation
// =============================================================================

export const useStore = create<AppState>()((...args) => ({
  ...createProjectSlice(...args),
  ...createRepositorySlice(...args),
  ...createSessionSlice(...args),
  ...createSessionDetailSlice(...args),
  ...createSubagentSlice(...args),
  ...createConversationSlice(...args),
  ...createTabSlice(...args),
  ...createTabUISlice(...args),
  ...createPaneSlice(...args),
  ...createUISlice(...args),
  ...createNotificationSlice(...args),
  ...createConfigSlice(...args),
  ...createConnectionSlice(...args),
  ...createUpdateSlice(...args),
}));

// =============================================================================
// Re-exports
// =============================================================================

// =============================================================================
// Store Initialization - Subscribe to IPC Events
// =============================================================================

/**
 * Initialize notification event listeners and fetch initial notification count.
 * Call this once when the app starts (e.g., in App.tsx useEffect).
 */
export function initializeNotificationListeners(): () => void {
  const cleanupFns: (() => void)[] = [];
  const pendingSessionRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingProjectRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const SESSION_REFRESH_DEBOUNCE_MS = 150;
  const PROJECT_REFRESH_DEBOUNCE_MS = 300;

  const scheduleSessionRefresh = (projectId: string, sessionId: string): void => {
    const key = `${projectId}/${sessionId}`;
    const existingTimer = pendingSessionRefreshTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      pendingSessionRefreshTimers.delete(key);
      const state = useStore.getState();
      void state.refreshSessionInPlace(projectId, sessionId);
    }, SESSION_REFRESH_DEBOUNCE_MS);
    pendingSessionRefreshTimers.set(key, timer);
  };

  const scheduleProjectRefresh = (projectId: string): void => {
    const existingTimer = pendingProjectRefreshTimers.get(projectId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      pendingProjectRefreshTimers.delete(projectId);
      const state = useStore.getState();
      void state.refreshSessionsInPlace(projectId);
    }, PROJECT_REFRESH_DEBOUNCE_MS);
    pendingProjectRefreshTimers.set(projectId, timer);
  };

  // Listen for new notifications from main process
  if (window.electronAPI.notifications?.onNew) {
    const cleanup = window.electronAPI.notifications.onNew((_event: unknown, error: unknown) => {
      // Cast the error to DetectedError type
      const notification = error as DetectedError;
      if (notification?.id) {
        // Keep list in sync immediately; unread count is synced via notification:updated/fetch.
        useStore.setState((state) => {
          if (state.notifications.some((n) => n.id === notification.id)) {
            return {};
          }
          return { notifications: [notification, ...state.notifications].slice(0, 200) };
        });
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Listen for notification updates from main process
  if (window.electronAPI.notifications?.onUpdated) {
    const cleanup = window.electronAPI.notifications.onUpdated(
      (_event: unknown, payload: { total: number; unreadCount: number }) => {
        const unreadCount =
          typeof payload.unreadCount === 'number' && Number.isFinite(payload.unreadCount)
            ? Math.max(0, Math.floor(payload.unreadCount))
            : 0;
        useStore.setState({ unreadCount });
      }
    );
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Navigate to error when user clicks a native OS notification
  if (window.electronAPI.notifications?.onClicked) {
    const cleanup = window.electronAPI.notifications.onClicked((_event: unknown, data: unknown) => {
      const error = data as DetectedError;
      if (error?.id && error?.sessionId && error?.projectId) {
        useStore.getState().navigateToError(error);
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Fetch after listeners are attached so startup events do not get overwritten by a stale response.
  void useStore.getState().fetchNotifications();

  /**
   * Check if a session is visible in any pane (not just the focused pane's active tab).
   * This ensures file change and task-list listeners refresh sessions shown in any split pane.
   */
  const isSessionVisibleInAnyPane = (sessionId: string): boolean => {
    const { paneLayout } = useStore.getState();
    return paneLayout.panes.some(
      (pane) =>
        pane.activeTabId != null &&
        pane.tabs.some(
          (tab) =>
            tab.id === pane.activeTabId && tab.type === 'session' && tab.sessionId === sessionId
        )
    );
  };

  // Listen for task-list file changes to refresh currently viewed session metadata
  if (window.electronAPI.onTodoChange) {
    const cleanup = window.electronAPI.onTodoChange((event) => {
      if (!event.sessionId || event.type === 'unlink') {
        return;
      }

      const state = useStore.getState();
      const isViewingSession =
        state.selectedSessionId === event.sessionId || isSessionVisibleInAnyPane(event.sessionId);

      if (isViewingSession) {
        // Find the project ID from any pane's tab that shows this session
        const allTabs = state.getAllPaneTabs();
        const sessionTab = allTabs.find(
          (t) => t.type === 'session' && t.sessionId === event.sessionId
        );
        if (sessionTab?.projectId) {
          scheduleSessionRefresh(sessionTab.projectId, event.sessionId);
        }
      }

      // Refresh project sessions list if applicable
      const activeTab = state.getActiveTab();
      const activeProjectId =
        activeTab?.type === 'session' && typeof activeTab.projectId === 'string'
          ? activeTab.projectId
          : null;
      if (activeProjectId && activeProjectId === state.selectedProjectId) {
        scheduleProjectRefresh(activeProjectId);
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Listen for file changes to auto-refresh current session and detect new sessions
  if (window.electronAPI.onFileChange) {
    const cleanup = window.electronAPI.onFileChange((event) => {
      // Skip unlink events
      if (event.type === 'unlink') {
        return;
      }

      const state = useStore.getState();

      // Handle new session added to a project (main session files only)
      if (event.type === 'add' && !event.isSubagent && event.projectId) {
        // Refresh sessions list if viewing this project (without loading state)
        if (state.selectedProjectId === event.projectId) {
          scheduleProjectRefresh(event.projectId);
        }
        return;
      }

      // Handle session or subagent content change
      if (event.type === 'change' && event.projectId && event.sessionId) {
        // Check if the changed session is visible in ANY pane (not just focused)
        const isViewingSession =
          state.selectedSessionId === event.sessionId || isSessionVisibleInAnyPane(event.sessionId);

        if (isViewingSession) {
          // Use refreshSessionInPlace to avoid flickering and preserve UI state
          scheduleSessionRefresh(event.projectId, event.sessionId);
        }
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Listen for updater status events from main process
  if (window.electronAPI.updater?.onStatus) {
    const cleanup = window.electronAPI.updater.onStatus((_event: unknown, status: unknown) => {
      const s = status as UpdaterStatus;
      switch (s.type) {
        case 'checking':
          useStore.setState({ updateStatus: 'checking' });
          break;
        case 'available':
          useStore.setState({
            updateStatus: 'available',
            availableVersion: s.version ?? null,
            releaseNotes: s.releaseNotes ?? null,
            showUpdateDialog: true,
          });
          break;
        case 'not-available':
          useStore.setState({ updateStatus: 'not-available' });
          break;
        case 'downloading':
          useStore.setState({
            updateStatus: 'downloading',
            downloadProgress: s.progress?.percent ?? 0,
          });
          break;
        case 'downloaded':
          useStore.setState({
            updateStatus: 'downloaded',
            downloadProgress: 100,
            availableVersion: s.version ?? useStore.getState().availableVersion,
          });
          break;
        case 'error':
          useStore.setState({
            updateStatus: 'error',
            updateError: s.error ?? 'Unknown error',
          });
          break;
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Listen for SSH connection status changes from main process
  if (window.electronAPI.ssh?.onStatus) {
    const cleanup = window.electronAPI.ssh.onStatus((_event: unknown, status: unknown) => {
      const s = status as { state: string; host: string | null; error: string | null };
      useStore
        .getState()
        .setConnectionStatus(
          s.state as 'disconnected' | 'connecting' | 'connected' | 'error',
          s.host,
          s.error
        );

      // Re-fetch all data when connection state changes to connected or disconnected
      if (s.state === 'connected' || s.state === 'disconnected') {
        const store = useStore.getState();
        void store.fetchProjects();
        void store.fetchRepositoryGroups();
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Return cleanup function
  return () => {
    for (const timer of pendingSessionRefreshTimers.values()) {
      clearTimeout(timer);
    }
    pendingSessionRefreshTimers.clear();
    for (const timer of pendingProjectRefreshTimers.values()) {
      clearTimeout(timer);
    }
    pendingProjectRefreshTimers.clear();
    cleanupFns.forEach((fn) => fn());
  };
}
