/**
 * Main process entry point for claude-devtools.
 *
 * Responsibilities:
 * - Initialize Electron app and main window
 * - Set up IPC handlers for data access
 * - Initialize services (ProjectScanner, SessionParser, etc.)
 * - Start file watcher for live updates
 * - Manage application lifecycle
 */

import {
  CACHE_CLEANUP_INTERVAL_MINUTES,
  CACHE_TTL_MINUTES,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  DEV_SERVER_PORT,
  getTrafficLightPositionForZoom,
  MAX_CACHE_SESSIONS,
  WINDOW_ZOOM_FACTOR_CHANGED_CHANNEL,
} from '@shared/constants';
import { createLogger } from '@shared/utils/logger';
import { app, BrowserWindow } from 'electron';
import { join } from 'path';

import {
  initializeIpcHandlers,
  reinitializeServiceHandlers,
  removeIpcHandlers,
} from './ipc/handlers';

// Icon path - works for both dev and production
const getIconPath = (): string => {
  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    return join(process.cwd(), 'resources/icon.png');
  }
  return join(__dirname, '../../resources/icon.png');
};

const logger = createLogger('App');
import { SSH_STATUS } from '@preload/constants/ipcChannels';

import {
  ChunkBuilder,
  configManager,
  DataCache,
  FileWatcher,
  NotificationManager,
  ProjectScanner,
  SessionParser,
  SshConnectionManager,
  SubagentResolver,
  UpdaterService,
} from './services';

// =============================================================================
// Application State
// =============================================================================

let mainWindow: BrowserWindow | null = null;

// Service instances
let projectScanner: ProjectScanner;
let sessionParser: SessionParser;
let subagentResolver: SubagentResolver;
let chunkBuilder: ChunkBuilder;
let dataCache: DataCache;
let fileWatcher: FileWatcher;
let notificationManager: NotificationManager;
let updaterService: UpdaterService;
let sshConnectionManager: SshConnectionManager;
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Initializes all services.
 */
function initializeServices(): void {
  logger.info('Initializing services...');

  // Initialize SSH connection manager
  sshConnectionManager = new SshConnectionManager();

  // Initialize services (paths are set automatically from environment)
  projectScanner = new ProjectScanner();
  sessionParser = new SessionParser(projectScanner);
  subagentResolver = new SubagentResolver(projectScanner);
  chunkBuilder = new ChunkBuilder();
  const disableCache = process.env.CLAUDE_CONTEXT_DISABLE_CACHE === '1';
  dataCache = new DataCache(MAX_CACHE_SESSIONS, CACHE_TTL_MINUTES, !disableCache);
  updaterService = new UpdaterService();

  logger.info(`Projects directory: ${projectScanner.getProjectsDir()}`);

  // Mode switch callback: recreates services with new provider when switching local↔SSH
  const handleModeSwitch = async (mode: 'local' | 'ssh'): Promise<void> => {
    logger.info(`Switching to ${mode} mode`);

    // Stop file watcher
    fileWatcher.stop();

    // Clear data cache
    dataCache.clear();

    // Get provider and projects path from connection manager
    const provider = sshConnectionManager.getProvider();
    const projectsDir =
      mode === 'ssh' ? (sshConnectionManager.getRemoteProjectsPath() ?? undefined) : undefined;

    // Recreate services with new provider
    projectScanner = new ProjectScanner(projectsDir, undefined, provider);
    sessionParser = new SessionParser(projectScanner);
    subagentResolver = new SubagentResolver(projectScanner);

    // Re-initialize IPC handler service references so subsequent calls use new instances
    reinitializeServiceHandlers(
      projectScanner,
      sessionParser,
      subagentResolver,
      chunkBuilder,
      dataCache
    );

    // Update file watcher provider
    fileWatcher.setFileSystemProvider(provider);

    // Restart file watcher
    fileWatcher.start();

    // Notify renderer to re-fetch all data
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(SSH_STATUS, sshConnectionManager.getStatus());
    }

    logger.info(`Mode switch to ${mode} complete`);
  };

  // Initialize IPC handlers (including SSH)
  initializeIpcHandlers(
    projectScanner,
    sessionParser,
    subagentResolver,
    chunkBuilder,
    dataCache,
    updaterService,
    sshConnectionManager,
    handleModeSwitch
  );

  // Forward SSH state changes to renderer
  sshConnectionManager.on('state-change', (status: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(SSH_STATUS, status);
    }
  });

  // Initialize notification manager using singleton pattern
  // This ensures IPC handlers and FileWatcher use the same instance
  // Note: mainWindow will be set later via setMainWindow() when window is created
  notificationManager = NotificationManager.getInstance();

  // Start file watcher with notification manager for error detection
  fileWatcher = new FileWatcher(dataCache);
  fileWatcher.setNotificationManager(notificationManager);
  fileWatcher.start();

  // Forward file change events to renderer
  // Note: Error detection is handled internally by FileWatcher via NotificationManager
  fileWatcher.on('file-change', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file-change', event);
    }
  });

  fileWatcher.on('todo-change', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('todo-change', event);
    }
  });

  // Start automatic cache cleanup
  cleanupInterval = dataCache.startAutoCleanup(CACHE_CLEANUP_INTERVAL_MINUTES);

  logger.info('Services initialized successfully');
}

/**
 * Shuts down all services.
 */
function shutdownServices(): void {
  logger.info('Shutting down services...');

  // Stop file watcher
  if (fileWatcher) {
    fileWatcher.stop();
  }

  // Stop cache cleanup
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  // Dispose SSH connection manager
  if (sshConnectionManager) {
    sshConnectionManager.dispose();
  }

  // Remove IPC handlers
  removeIpcHandlers();

  logger.info('Services shut down successfully');
}

/**
 * Update native traffic-light position and notify renderer of the current zoom factor.
 */
function syncTrafficLightPosition(win: BrowserWindow): void {
  const zoomFactor = win.webContents.getZoomFactor();
  const position = getTrafficLightPositionForZoom(zoomFactor);
  win.setWindowButtonPosition(position);
  win.webContents.send(WINDOW_ZOOM_FACTOR_CHANGED_CHANNEL, zoomFactor);
}

/**
 * Creates the main application window.
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    icon: getIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hidden',
    trafficLightPosition: getTrafficLightPositionForZoom(1),
    title: 'claude-devtools',
  });

  // Load the renderer
  if (process.env.NODE_ENV === 'development') {
    void mainWindow.loadURL(`http://localhost:${DEV_SERVER_PORT}`);
    mainWindow.webContents.openDevTools();
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // Set traffic light position + notify renderer on first load, and auto-check for updates
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      syncTrafficLightPosition(mainWindow);
      // Auto-check for updates 3 seconds after window loads
      setTimeout(() => updaterService.checkForUpdates(), 3000);
    }
  });

  // Sync traffic light position when zoom changes (Cmd+/-, Cmd+0)
  // zoom-changed event doesn't fire in Electron 40, so we detect zoom keys directly.
  // Also keeps zoom bounds within a practical readability range.
  const MIN_ZOOM_LEVEL = -3; // ~70%
  const MAX_ZOOM_LEVEL = 5;
  const ZOOM_IN_KEYS = new Set(['+', '=']);
  const ZOOM_OUT_KEYS = new Set(['-', '_']);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!input.meta || input.type !== 'keyDown') return;

    const currentLevel = mainWindow.webContents.getZoomLevel();

    // Block zoom-out beyond minimum
    if (ZOOM_OUT_KEYS.has(input.key) && currentLevel <= MIN_ZOOM_LEVEL) {
      event.preventDefault();
      return;
    }
    // Block zoom-in beyond maximum
    if (ZOOM_IN_KEYS.has(input.key) && currentLevel >= MAX_ZOOM_LEVEL) {
      event.preventDefault();
      return;
    }

    // For zoom keys (including Cmd+0 reset), defer sync until zoom is applied
    if (ZOOM_IN_KEYS.has(input.key) || ZOOM_OUT_KEYS.has(input.key) || input.key === '0') {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          syncTrafficLightPosition(mainWindow);
        }
      }, 100);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Clear main window references
    if (notificationManager) {
      notificationManager.setMainWindow(null);
    }
    if (updaterService) {
      updaterService.setMainWindow(null);
    }
  });

  // Handle renderer process crashes (render-process-gone replaces deprecated 'crashed' event)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process gone:', details.reason, details.exitCode);
    // Could show an error dialog or attempt to reload the window
  });

  // Set main window reference for notification manager and updater
  if (notificationManager) {
    notificationManager.setMainWindow(mainWindow);
  }
  if (updaterService) {
    updaterService.setMainWindow(mainWindow);
  }

  logger.info('Main window created');
}

/**
 * Application ready handler.
 */
void app.whenReady().then(() => {
  logger.info('App ready, initializing...');

  // Initialize services first
  initializeServices();

  // Apply configuration settings
  const config = configManager.getConfig();

  // Apply launch at login setting
  app.setLoginItemSettings({
    openAtLogin: config.general.launchAtLogin,
  });

  // Apply dock visibility and icon (macOS)
  if (process.platform === 'darwin') {
    if (!config.general.showDockIcon) {
      app.dock?.hide();
    }
    // Set dock icon
    app.dock?.setIcon(getIconPath());
  }

  // Then create window
  createWindow();

  // Listen for notification click events
  notificationManager.on('notification-clicked', (_error) => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

/**
 * All windows closed handler.
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Before quit handler - cleanup.
 */
app.on('before-quit', () => {
  shutdownServices();
});
