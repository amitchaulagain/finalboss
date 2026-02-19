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

export const setupChromeDriver = async (botName: string = 'seek'): Promise<{ driver: WebDriver; actions: any; sessionExists: boolean; sessionsDir: string; stopMonitoring?: () => void }> => {
  try {
    const configPath = path.join(__dirname, '../user-bots-config.json');
    const config: BotConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // Create session management like botrunner.ts
    const sessionsDir = path.join(process.cwd(), 'sessions', botName);
    const screenshotsDir = path.join(sessionsDir, 'screenshots');
    const logsDir = path.join(sessionsDir, 'logs');
    const resumeDir = path.join(sessionsDir, 'resume');
    const tempDir = path.join(sessionsDir, 'temp');

    makeDirectories([sessionsDir, screenshotsDir, logsDir, resumeDir, tempDir]);

    // Check if session exists (has saved data)
    const sessionExists = fs.readdirSync(sessionsDir).filter(file =>
      !['screenshots', 'logs', 'resume', 'temp'].includes(file)
    ).length > 0;

    const options = new Options();

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
      options.addArguments('--headless');
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

    await driver.manage().window().maximize();

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

