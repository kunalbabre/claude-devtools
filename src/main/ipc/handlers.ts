/**
 * IPC Handlers - Orchestrates domain-specific handler modules.
 *
 * This module initializes and registers all IPC handlers from domain modules:
 * - projects.ts: Project listing and repository groups
 * - sessions.ts: Session operations and pagination
 * - search.ts: Session search functionality
 * - subagents.ts: Subagent detail retrieval
 * - validation.ts: Path validation and scroll handling
 * - utility.ts: Shell operations and file reading
 * - notifications.ts: Notification management
 * - config.ts: App configuration
 * - ssh.ts: SSH connection management
 */

import { createLogger } from '@shared/utils/logger';
import { ipcMain } from 'electron';

import { registerConfigHandlers, removeConfigHandlers } from './config';

const logger = createLogger('IPC:handlers');
import { registerNotificationHandlers, removeNotificationHandlers } from './notifications';
import {
  initializeProjectHandlers,
  registerProjectHandlers,
  removeProjectHandlers,
} from './projects';
import { initializeSearchHandlers, registerSearchHandlers, removeSearchHandlers } from './search';
import {
  initializeSessionHandlers,
  registerSessionHandlers,
  removeSessionHandlers,
} from './sessions';
import { initializeSshHandlers, registerSshHandlers, removeSshHandlers } from './ssh';
import {
  initializeSubagentHandlers,
  registerSubagentHandlers,
  removeSubagentHandlers,
} from './subagents';
import {
  initializeUpdaterHandlers,
  registerUpdaterHandlers,
  removeUpdaterHandlers,
} from './updater';
import { registerUtilityHandlers, removeUtilityHandlers } from './utility';
import { registerValidationHandlers, removeValidationHandlers } from './validation';

import type {
  ChunkBuilder,
  DataCache,
  ProjectScanner,
  SessionParser,
  SshConnectionManager,
  SubagentResolver,
  UpdaterService,
} from '../services';

/**
 * Initializes IPC handlers with service instances.
 */
export function initializeIpcHandlers(
  scanner: ProjectScanner,
  parser: SessionParser,
  resolver: SubagentResolver,
  builder: ChunkBuilder,
  cache: DataCache,
  updater: UpdaterService,
  sshManager?: SshConnectionManager,
  sshModeSwitchCallback?: (mode: 'local' | 'ssh') => Promise<void>
): void {
  // Initialize domain handlers with their required services
  initializeProjectHandlers(scanner);
  initializeSessionHandlers(scanner, parser, resolver, builder, cache);
  initializeSearchHandlers(scanner);
  initializeSubagentHandlers(builder, cache, parser, resolver);
  initializeUpdaterHandlers(updater);
  if (sshManager && sshModeSwitchCallback) {
    initializeSshHandlers(sshManager, sshModeSwitchCallback);
  }

  // Register all handlers
  registerProjectHandlers(ipcMain);
  registerSessionHandlers(ipcMain);
  registerSearchHandlers(ipcMain);
  registerSubagentHandlers(ipcMain);
  registerValidationHandlers(ipcMain);
  registerUtilityHandlers(ipcMain);
  registerNotificationHandlers(ipcMain);
  registerConfigHandlers(ipcMain);
  registerUpdaterHandlers(ipcMain);
  if (sshManager) {
    registerSshHandlers(ipcMain);
  }

  logger.info('All handlers registered');
}

/**
 * Re-initializes service-dependent IPC handlers after a mode switch (local ↔ SSH).
 * This updates the module-level service references held by each domain handler module,
 * ensuring IPC calls after the switch use the new service instances.
 */
export function reinitializeServiceHandlers(
  scanner: ProjectScanner,
  parser: SessionParser,
  resolver: SubagentResolver,
  builder: ChunkBuilder,
  cache: DataCache
): void {
  initializeProjectHandlers(scanner);
  initializeSessionHandlers(scanner, parser, resolver, builder, cache);
  initializeSearchHandlers(scanner);
  initializeSubagentHandlers(builder, cache, parser, resolver);
  logger.info('Service handlers re-initialized after mode switch');
}

/**
 * Removes all IPC handlers.
 * Should be called when shutting down.
 */
export function removeIpcHandlers(): void {
  removeProjectHandlers(ipcMain);
  removeSessionHandlers(ipcMain);
  removeSearchHandlers(ipcMain);
  removeSubagentHandlers(ipcMain);
  removeValidationHandlers(ipcMain);
  removeUtilityHandlers(ipcMain);
  removeNotificationHandlers(ipcMain);
  removeConfigHandlers(ipcMain);
  removeUpdaterHandlers(ipcMain);
  removeSshHandlers(ipcMain);

  logger.info('All handlers removed');
}
