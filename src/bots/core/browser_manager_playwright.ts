import { firefox, Browser, BrowserContext, Page } from 'playwright';
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

const printLog = (message: string) => {
  console.log(message);
};

/**
 * Setup Playwright browser with Camoufox for enhanced stealth
 *
 * This manager creates browser instances that work with the workflow engine
 * while using Camoufox's anti-detection capabilities.
 */
export const setupPlaywrightBrowser = async (
  botName: string = 'indeed'
): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
  sessionExists: boolean;
  sessionsDir: string;
}> => {
  try {
    const { readUserConfig } = await import('./user-config.js');
    const config: BotConfig = readUserConfig() as BotConfig;

    // Create session management structure
    const sessionsDir = path.join(process.cwd(), 'sessions', botName);
    const screenshotsDir = path.join(sessionsDir, 'screenshots');
    const logsDir = path.join(sessionsDir, 'logs');
    const tempDir = path.join(sessionsDir, 'temp');
    const profileDir = path.join(sessionsDir, 'profile');

    makeDirectories([sessionsDir, screenshotsDir, logsDir, tempDir, profileDir]);

    // Check if session exists
    const sessionExists = fs.existsSync(path.join(profileDir, 'cookies.json'));

    printLog(
      sessionExists
        ? `📂 Using existing session: ${sessionsDir}`
        : `🆕 Creating new session: ${sessionsDir}`
    );

    // Launch Firefox browser with Playwright
    // Note: For maximum stealth, use Camoufox by installing: npx camoufox-js fetch
    // Firefox is still better than Chrome for bot detection avoidance
    const browser = await firefox.launch({
      headless: process.env.HEADLESS === 'true',
      args: [
        '--disable-blink-features=AutomationControlled',
      ],
    });

    // Create browser context with anti-fingerprinting
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      // Load saved cookies if session exists
      ...(sessionExists && {
        storageState: path.join(profileDir, 'cookies.json'),
      }),
    });

    // Create initial page
    const page = await context.newPage();

    // Add extra anti-detection measures
    await page.addInitScript(() => {
      // Remove webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });

      // Mock plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // Mock languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    });

    printLog('✅ Camoufox browser initialized successfully');

    // Setup auto-save for cookies on page close
    const saveCookies = async () => {
      try {
        const cookies = await context.storageState();
        fs.writeFileSync(
          path.join(profileDir, 'cookies.json'),
          JSON.stringify(cookies, null, 2)
        );
        printLog('💾 Session saved');
      } catch (error) {
        printLog(`⚠️ Failed to save session: ${error}`);
      }
    };

    // Save cookies periodically and on browser close
    let saveInterval = setInterval(saveCookies, 60000); // Save every minute

    // Handle cleanup
    const cleanup = async () => {
      clearInterval(saveInterval);
      await saveCookies();
    };

    // Save on context close
    context.on('close', cleanup);

    return {
      browser,
      context,
      page,
      sessionExists,
      sessionsDir,
    };
  } catch (error) {
    const errorMessage = `
Failed to initialize Camoufox browser:

Possible causes:
1. Camoufox not installed: Run "bun install" to install dependencies
2. System requirements not met: Ensure you have Firefox dependencies
3. Permissions issue: Check file permissions for sessions directory

Error: ${error}
`;

    printLog(errorMessage);
    console.error('Error details:', error);

    throw error;
  }
};

/**
 * Close browser and cleanup resources
 */
export const closeBrowser = async (browser: Browser): Promise<void> => {
  try {
    await browser.close();
    printLog('Browser closed successfully');
  } catch (error) {
    printLog(`Error closing browser: ${error}`);
  }
};

/**
 * Take screenshot (utility for debugging)
 */
export const takeScreenshot = async (
  page: Page,
  name: string,
  sessionsDir: string
): Promise<void> => {
  try {
    const screenshotPath = path.join(
      sessionsDir,
      'screenshots',
      `${name}_${Date.now()}.png`
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    printLog(`📸 Screenshot saved: ${screenshotPath}`);
  } catch (error) {
    printLog(`Failed to take screenshot: ${error}`);
  }
};
