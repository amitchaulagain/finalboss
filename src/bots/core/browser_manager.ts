import { Builder, WebDriver } from 'selenium-webdriver';
import { Options } from 'selenium-webdriver/chrome';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface BotConfig {
  formData: {
    enableDeepSeek: boolean;
    deepSeekApiKey: string;
    acceptTerms: boolean;
  };
}

const makeDirectories = (dirs: string[]) => {
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
};

const findDefaultProfileDirectory = (): string | null => {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) return null;

  const profilePaths = [
    path.join(homeDir, '.config/google-chrome/Default'),
    path.join(homeDir, 'Library/Application Support/Google/Chrome/Default'),
    path.join(homeDir, 'AppData/Local/Google/Chrome/User Data/Default')
  ];

  for (const profilePath of profilePaths) {
    if (fs.existsSync(profilePath)) {
      return path.dirname(profilePath);
    }
  }
  return null;
};

const printLog = (message: string) => {
  console.log(message);
};

// Kill all Chrome processes spawned by this bot
export const killAllChromeProcesses = async (): Promise<void> => {
  printLog("🔥 Emergency: Killing all Chrome processes...");

  try {
    const platform = process.platform;

    if (platform === 'linux' || platform === 'darwin') {
      // Unix-based systems
      const { execSync } = await import('child_process');

      // Kill all chrome processes owned by current user
      try {
        execSync('pkill -9 chrome', { stdio: 'ignore' });
        execSync('pkill -9 chromium', { stdio: 'ignore' });
        printLog("✅ Chrome processes killed");
      } catch (e) {
        // Process might not exist, that's ok
        printLog("⚠️ No Chrome processes to kill or insufficient permissions");
      }
    } else if (platform === 'win32') {
      // Windows
      const { execSync } = await import('child_process');

      try {
        execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
        printLog("✅ Chrome processes killed");
      } catch (e) {
        printLog("⚠️ No Chrome processes to kill or insufficient permissions");
      }
    }
  } catch (error) {
    printLog(`❌ Failed to kill Chrome processes: ${error}`);
  }
};

// Monitor browser windows and detect manual closure
export const monitorBrowserClose = (driver: WebDriver, onBrowserClosed?: () => void): (() => void) => {
  const checkInterval = setInterval(async () => {
    try {
      const handles = await driver.getAllWindowHandles();
      if (handles.length === 0) {
        printLog("Browser manually closed by user - shutting down bot");
        clearInterval(checkInterval);
        if (onBrowserClosed) {
          onBrowserClosed();
        } else {
          process.exit(0);
        }
      }
    } catch (error) {
      // Browser is no longer accessible
      printLog("Browser connection lost - shutting down bot");
      clearInterval(checkInterval);
      if (onBrowserClosed) {
        onBrowserClosed();
      } else {
        process.exit(0);
      }
    }
  }, 2000); // Check every 2 seconds

  // Return function to stop monitoring
  return () => {
    clearInterval(checkInterval);
  };
};

/**
 * Cleans stale Chrome LOCK files from a session directory.
 * Only removes LOCK files older than 1 hour to prevent removing active locks.
 *
 * @param sessionDir - The Chrome user-data-dir path
 */
const cleanStaleLockFiles = (sessionDir: string): void => {
  try {
    printLog(`Checking for stale LOCK files in: ${sessionDir}`);

    // Recursively find all LOCK files in the session directory
    const files = fs.readdirSync(sessionDir, { recursive: true, withFileTypes: true });
    const lockFiles = files
      .filter(file => file.isFile() && file.name === 'LOCK')
      .map(file => path.join(file.path || file.parentPath || sessionDir, file.name));

    if (lockFiles.length === 0) {
      printLog('No LOCK files found - clean session');
      return;
    }

    printLog(`Found ${lockFiles.length} LOCK files, checking staleness...`);

    const ONE_HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();
    let removedCount = 0;
    let skippedCount = 0;

    for (const lockFile of lockFiles) {
      try {
        const stats = fs.statSync(lockFile);
        const ageMs = now - stats.mtimeMs;

        // Only remove LOCK files older than 1 hour (safety margin)
        if (ageMs > ONE_HOUR_MS) {
          fs.unlinkSync(lockFile);
          removedCount++;
          printLog(`  Removed stale LOCK (${Math.round(ageMs / 1000 / 60)} min old): ${path.relative(sessionDir, lockFile)}`);
        } else {
          skippedCount++;
          printLog(`  Skipped recent LOCK (${Math.round(ageMs / 1000 / 60)} min old): ${path.relative(sessionDir, lockFile)}`);
        }
      } catch (err) {
        // File might have been deleted by another process, or permission issue
        printLog(`  Could not process LOCK: ${path.relative(sessionDir, lockFile)} - ${err}`);
      }
    }

    if (removedCount > 0) {
      printLog(`✓ Cleanup complete: removed ${removedCount} stale LOCK files`);
    }
    if (skippedCount > 0) {
      printLog(`Kept ${skippedCount} recent LOCK files (< 1 hour old)`);
    }
  } catch (error) {
    // Don't fail bot startup if cleanup fails
    printLog(`Warning: LOCK cleanup failed (continuing anyway): ${error}`);
  }
};

export const setupChromeDriver = async (botName: string = 'seek'): Promise<{ driver: WebDriver; actions: any; sessionExists: boolean; sessionsDir: string; stopMonitoring?: () => void }> => {
  try {
    const { readUserConfig } = await import('./user-config.js');
    const config: BotConfig = readUserConfig() as BotConfig;

    // Create session management like botrunner.ts
    const sessionsDir = path.join(process.cwd(), 'sessions', botName);
    const screenshotsDir = path.join(sessionsDir, 'screenshots');
    const logsDir = path.join(sessionsDir, 'logs');
    const resumeDir = path.join(sessionsDir, 'resume');
    const tempDir = path.join(sessionsDir, 'temp');

    makeDirectories([sessionsDir, screenshotsDir, logsDir, resumeDir, tempDir]);

    // Clean stale LOCK files before checking session
    cleanStaleLockFiles(sessionsDir);

    // Check if session exists (has saved data)
    const sessionExists = fs.readdirSync(sessionsDir).filter(file =>
      !['screenshots', 'logs', 'resume', 'temp'].includes(file)
    ).length > 0;

    const options = new Options();

    // CRITICAL: Enable CDP explicitly (Chrome 144+ requirement)
    // Without this, Runtime.evaluate and all executeScript() calls fail
    options.addArguments('--remote-debugging-port=9222');
    printLog('🔍 Enabled Chrome DevTools Protocol on port 9222');

    // Wayland support for Linux (Sway/GNOME Wayland/etc.)
    if (process.platform === 'linux') {
      // Check if running on Wayland
      const isWayland = process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland';

      if (isWayland) {
        printLog('🔍 Detected Wayland session - configuring Chrome for Wayland');
        options.addArguments('--ozone-platform=wayland');
        options.addArguments('--enable-features=UseOzonePlatform,WaylandWindowDecorations');
      } else {
        printLog('🔍 Detected X11 session');
      }
    }

    const runInBackground = process.env.HEADLESS === 'true';
    const disableExtensions = process.env.DISABLE_EXTENSIONS === 'true';
    const safeMode = process.env.SAFE_MODE === 'true';
    const useRealProfile = process.env.USE_REAL_CHROME === 'true';

    // STEALTH MODE: Minimal flags to avoid detection
    if (!runInBackground) {
      // Only add essential flags for non-headless
      options.addArguments('--no-sandbox');
      options.addArguments('--disable-dev-shm-usage');
    } else {
      // Headless mode (easier to detect)
      options.addArguments('--headless=new');
      options.addArguments('--no-sandbox');
      options.addArguments('--disable-dev-shm-usage');
      options.addArguments('--disable-gpu');
    }

    if (disableExtensions) {
      options.addArguments('--disable-extensions');
    }

    // CRITICAL: Use real Chrome profile to avoid Cloudflare detection
    if (useRealProfile) {
      const realChromeProfile = findDefaultProfileDirectory();
      if (realChromeProfile) {
        // IMPORTANT: Use a COPY of the profile to avoid locking issues
        // Chrome can't use same profile in multiple instances
        const profileCopyDir = path.join(sessionsDir, 'chrome-profile-copy');

        printLog(`🔥 STEALTH MODE: Copying your real Chrome profile...`);
        printLog(`   From: ${realChromeProfile}`);
        printLog(`   To: ${profileCopyDir}`);

        // Copy profile if it doesn't exist
        if (!fs.existsSync(profileCopyDir)) {
          try {
            // Copy the Default profile directory
            const sourceProfile = path.join(realChromeProfile, 'Default');
            const targetProfile = path.join(profileCopyDir, 'Default');

            if (fs.existsSync(sourceProfile)) {
              fs.mkdirSync(targetProfile, { recursive: true });

              // Copy only essential files for stealth (cookies, preferences)
              const essentialFiles = ['Cookies', 'Preferences', 'Local Storage', 'History'];
              for (const file of essentialFiles) {
                const sourcePath = path.join(sourceProfile, file);
                const targetPath = path.join(targetProfile, file);

                if (fs.existsSync(sourcePath)) {
                  try {
                    if (fs.lstatSync(sourcePath).isDirectory()) {
                      fs.cpSync(sourcePath, targetPath, { recursive: true });
                    } else {
                      fs.cpSync(sourcePath, targetPath);
                    }
                    printLog(`   ✓ Copied ${file}`);
                  } catch (copyError) {
                    printLog(`   ⚠️ Could not copy ${file}: ${copyError}`);
                  }
                }
              }

              printLog(`✅ Profile copied successfully`);
            }
          } catch (error) {
            printLog(`⚠️ Profile copy failed: ${error}`);
            printLog(`⚠️ Using fresh bot session instead`);
          }
        } else {
          printLog(`✅ Using existing profile copy`);
        }

        options.addArguments(`--user-data-dir=${profileCopyDir}`);
        options.addArguments('--profile-directory=Default');
      } else {
        printLog('⚠️ Could not find real Chrome profile, using bot session instead');
        options.addArguments(`--user-data-dir=${sessionsDir}`);
      }
    } else if (safeMode) {
      printLog('SAFE MODE: Will login with a guest profile, browsing history will not be saved in the browser!');
    } else {
      // Use the session directory for Chrome profile (like botrunner.ts)
      options.addArguments(`--user-data-dir=${sessionsDir}`);
      if (sessionExists) {
        printLog(`Using existing session: ${sessionsDir}`);
      } else {
        printLog(`Creating new session: ${sessionsDir}`);
      }
    }

    // STEALTH: Exclude automation switches that Cloudflare detects
    options.excludeSwitches('enable-automation', 'enable-logging');

    // STEALTH: Add arguments to look like a normal user
    options.addArguments('--disable-blink-features=AutomationControlled');

    // Selenium Manager will automatically download the correct ChromeDriver version
    // for the user's Chrome browser - no manual chromedriver package needed!
    const driver = await new Builder()
      .forBrowser('chrome')
      .setChromeOptions(options)
      .build();

    // Try to maximize window (may fail on Wayland)
    try {
      await driver.manage().window().maximize();
      printLog("✅ Window maximized");
    } catch (maximizeError) {
      printLog(`⚠️ Maximize failed (${maximizeError.message}), using fallback`);
      // Fallback: Set window size manually
      try {
        await driver.manage().window().setRect({ width: 1920, height: 1080, x: 0, y: 0 });
        printLog("✅ Window resized to 1920x1080");
      } catch (resizeError) {
        printLog(`⚠️ Resize also failed (continuing anyway): ${resizeError.message}`);
        // Continue anyway - window size is not critical
      }
    }

    const actions = driver.actions();

    // Start monitoring for manual browser closure
    const stopMonitoring = monitorBrowserClose(driver);

    return { driver, actions, sessionExists, sessionsDir, stopMonitoring };

  } catch (error) {
    const errorMessage = 'Seems like either... \n\n1. Chrome is already running. \nA. Close all Chrome windows and try again. \n\n2. Google Chrome or Chromedriver is out dated. \nA. Update browser and Chromedriver! \n\n3. Chrome not installed or not in PATH. \nA. Install Chrome and ensure chromedriver is in PATH. \n\nPlease check GitHub discussions/support for solutions';

    printLog(errorMessage);
    console.error('Error in opening Chrome:', error);

    throw error;
  }
};

