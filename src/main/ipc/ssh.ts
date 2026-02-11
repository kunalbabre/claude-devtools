/**
 * SSH IPC Handlers - Manages SSH connection lifecycle from renderer requests.
 *
 * Channels:
 * - ssh:connect - Connect to SSH host, switch to remote mode
 * - ssh:disconnect - Disconnect and switch back to local mode
 * - ssh:getState - Get current connection state
 * - ssh:test - Test connection without switching
 */

import {
  SSH_CONNECT,
  SSH_DISCONNECT,
  SSH_GET_CONFIG_HOSTS,
  SSH_GET_LAST_CONNECTION,
  SSH_GET_STATE,
  SSH_RESOLVE_HOST,
  SSH_SAVE_LAST_CONNECTION,
  SSH_TEST,
} from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';

import { configManager } from '../services';

import type {
  SshConnectionConfig,
  SshConnectionManager,
  SshConnectionStatus,
} from '../services/infrastructure/SshConnectionManager';
import type { SshLastConnection } from '@shared/types';
import type { IpcMain } from 'electron';

const logger = createLogger('IPC:ssh');

// =============================================================================
// Module State
// =============================================================================

let connectionManager: SshConnectionManager;
let onModeSwitch: ((mode: 'local' | 'ssh') => Promise<void>) | null = null;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize SSH handlers with required services.
 * @param manager - The SSH connection manager instance
 * @param modeSwitchCallback - Called when switching between local/SSH mode
 */
export function initializeSshHandlers(
  manager: SshConnectionManager,
  modeSwitchCallback: (mode: 'local' | 'ssh') => Promise<void>
): void {
  connectionManager = manager;
  onModeSwitch = modeSwitchCallback;
}

// =============================================================================
// Handler Registration
// =============================================================================

export function registerSshHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(SSH_CONNECT, async (_event, config: SshConnectionConfig) => {
    try {
      await connectionManager.connect(config);
      if (onModeSwitch) {
        await onModeSwitch('ssh');
      }
      return { success: true, data: connectionManager.getStatus() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('SSH connect failed:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle(SSH_DISCONNECT, async () => {
    try {
      connectionManager.disconnect();
      if (onModeSwitch) {
        await onModeSwitch('local');
      }
      return { success: true, data: connectionManager.getStatus() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('SSH disconnect failed:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle(SSH_GET_STATE, async (): Promise<SshConnectionStatus> => {
    return connectionManager.getStatus();
  });

  ipcMain.handle(SSH_TEST, async (_event, config: SshConnectionConfig) => {
    try {
      const result = await connectionManager.testConnection(config);
      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  ipcMain.handle(SSH_GET_CONFIG_HOSTS, async () => {
    try {
      const hosts = await connectionManager.getConfigHosts();
      return { success: true, data: hosts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to get SSH config hosts:', message);
      return { success: true, data: [] };
    }
  });

  ipcMain.handle(SSH_RESOLVE_HOST, async (_event, alias: string) => {
    try {
      const entry = await connectionManager.resolveHostConfig(alias);
      return { success: true, data: entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to resolve SSH host "${alias}":`, message);
      return { success: true, data: null };
    }
  });

  ipcMain.handle(SSH_SAVE_LAST_CONNECTION, async (_event, config: SshLastConnection) => {
    try {
      configManager.updateConfig('ssh', {
        lastConnection: {
          host: config.host,
          port: config.port,
          username: config.username,
          authMethod: config.authMethod,
          privateKeyPath: config.privateKeyPath,
        },
      });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to save SSH connection:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle(SSH_GET_LAST_CONNECTION, async () => {
    try {
      const config = configManager.getConfig();
      return { success: true, data: config.ssh.lastConnection };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to get last SSH connection:', message);
      return { success: true, data: null };
    }
  });

  logger.info('SSH handlers registered');
}

export function removeSshHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(SSH_CONNECT);
  ipcMain.removeHandler(SSH_DISCONNECT);
  ipcMain.removeHandler(SSH_GET_STATE);
  ipcMain.removeHandler(SSH_TEST);
  ipcMain.removeHandler(SSH_GET_CONFIG_HOSTS);
  ipcMain.removeHandler(SSH_RESOLVE_HOST);
  ipcMain.removeHandler(SSH_SAVE_LAST_CONNECTION);
  ipcMain.removeHandler(SSH_GET_LAST_CONNECTION);
}
