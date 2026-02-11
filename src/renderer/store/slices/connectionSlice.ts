/**
 * Connection Slice - Manages SSH connection state.
 *
 * Tracks connection mode (local/ssh), connection state,
 * and provides actions for connecting/disconnecting.
 */

import { getFullResetState } from '../utils/stateResetHelpers';

import type { AppState } from '../types';
import type {
  SshConfigHostEntry,
  SshConnectionConfig,
  SshConnectionState,
  SshLastConnection,
} from '@shared/types';
import type { StateCreator } from 'zustand';

// =============================================================================
// Slice Interface
// =============================================================================

export interface ConnectionSlice {
  // State
  connectionMode: 'local' | 'ssh';
  connectionState: SshConnectionState;
  connectedHost: string | null;
  connectionError: string | null;
  sshConfigHosts: SshConfigHostEntry[];
  lastSshConfig: SshLastConnection | null;

  // Actions
  connectSsh: (config: SshConnectionConfig) => Promise<void>;
  disconnectSsh: () => Promise<void>;
  testConnection: (config: SshConnectionConfig) => Promise<{ success: boolean; error?: string }>;
  setConnectionStatus: (
    state: SshConnectionState,
    host: string | null,
    error: string | null
  ) => void;
  fetchSshConfigHosts: () => Promise<void>;
  resolveConfigHost: (alias: string) => Promise<SshConfigHostEntry | null>;
  loadLastConnection: () => Promise<void>;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createConnectionSlice: StateCreator<AppState, [], [], ConnectionSlice> = (
  set,
  get
) => ({
  // Initial state
  connectionMode: 'local',
  connectionState: 'disconnected',
  connectedHost: null,
  connectionError: null,
  sshConfigHosts: [],
  lastSshConfig: null,

  // Actions
  connectSsh: async (config: SshConnectionConfig): Promise<void> => {
    set({
      connectionState: 'connecting',
      connectedHost: config.host,
      connectionError: null,
    });

    try {
      const status = await window.electronAPI.ssh.connect(config);
      set({
        connectionMode: status.state === 'connected' ? 'ssh' : 'local',
        connectionState: status.state,
        connectedHost: status.host,
        connectionError: status.error,
        // Clear stale local selections so dashboard shows fresh remote data
        ...(status.state === 'connected' ? getFullResetState() : {}),
      });

      // Re-fetch all data and persist config when connected
      if (status.state === 'connected') {
        const state = get();
        void state.fetchProjects();
        void state.fetchRepositoryGroups();

        // Save connection config (without password) for form pre-fill on next launch
        const saved: SshLastConnection = {
          host: config.host,
          port: config.port,
          username: config.username,
          authMethod: config.authMethod,
          privateKeyPath: config.privateKeyPath,
        };
        set({ lastSshConfig: saved });
        void window.electronAPI.ssh.saveLastConnection(saved);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        connectionState: 'error',
        connectionError: message,
      });
    }
  },

  disconnectSsh: async (): Promise<void> => {
    try {
      const status = await window.electronAPI.ssh.disconnect();
      set({
        connectionMode: 'local',
        connectionState: status.state,
        connectedHost: null,
        connectionError: null,
        // Clear stale remote selections so dashboard shows fresh local data
        ...getFullResetState(),
      });

      // Re-fetch local data
      const state = get();
      void state.fetchProjects();
      void state.fetchRepositoryGroups();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ connectionError: message });
    }
  },

  testConnection: async (
    config: SshConnectionConfig
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      return await window.electronAPI.ssh.test(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  },

  setConnectionStatus: (
    state: SshConnectionState,
    host: string | null,
    error: string | null
  ): void => {
    set({
      connectionState: state,
      connectionMode: state === 'connected' ? 'ssh' : 'local',
      connectedHost: host,
      connectionError: error,
    });
  },

  fetchSshConfigHosts: async (): Promise<void> => {
    try {
      const hosts = await window.electronAPI.ssh.getConfigHosts();
      set({ sshConfigHosts: hosts });
    } catch {
      // Gracefully ignore - SSH config may not exist
      set({ sshConfigHosts: [] });
    }
  },

  resolveConfigHost: async (alias: string): Promise<SshConfigHostEntry | null> => {
    try {
      return await window.electronAPI.ssh.resolveHost(alias);
    } catch {
      return null;
    }
  },

  loadLastConnection: async (): Promise<void> => {
    try {
      const saved = await window.electronAPI.ssh.getLastConnection();
      set({ lastSshConfig: saved });
    } catch {
      // Gracefully ignore - no saved connection
    }
  },
});
