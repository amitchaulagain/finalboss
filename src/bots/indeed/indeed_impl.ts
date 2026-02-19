import { WebDriver, By, until } from 'selenium-webdriver';
import { setupChromeDriver } from '../core/browser_manager';
import { HumanBehavior, StealthFeatures, DEFAULT_HUMANIZATION } from '../core/humanization';
import { UniversalSessionManager, SessionConfigs } from '../core/sessionManager';
import { UniversalOverlay } from '../core/universal_overlay';
import type { WorkflowContext } from '../core/workflow_engine';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = "https://indeed.com";

const printLog = (message: string) => {
  console.log(message);
};

// Build search URL from keywords and location
function buildSearchUrl(base_url: string, keywords: string, location: string): string {
  const keywordParam = keywords ? `q=${encodeURIComponent(keywords)}` : '';
  const locationParam = location ? `l=${encodeURIComponent(location)}` : '';

  const params = [keywordParam, locationParam].filter(p => p).join('&');
  return `${base_url}/jobs?${params}`;
}

/**
 * Step 0: Initialize Context
 *
 * REQUIRED: Load selectors, config, and initialize context variables
 */
export async function* step0(ctx: PlaywrightWorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const selectors = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'config/indeed_selectors.json'), 'utf8')
    );

    const config = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../user-bots-config.json'), 'utf8')
    );

    // Set context
    ctx.selectors = selectors;
    ctx.config = config;

    // Build Indeed search URL
    const keywords = config.formData?.keywords || '';
    const location = config.formData?.locations || '';
    ctx.indeed_url = buildSearchUrl(BASE_URL, keywords, location);

    printLog(`📋 Context initialized`);
    printLog(`🔍 Search URL: ${ctx.indeed_url}`);

    yield "ctx_ready";
  } catch (error) {
    printLog(`❌ Context initialization failed: ${error}`);
    yield "ctx_failed";
  }
}

/**
 * Step 1: Open Homepage and Setup Browser
 *
 * REQUIRED: Initialize Camoufox browser with humanization and stealth
 */
export async function* openHomepage(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    printLog(`🌐 Opening Indeed with Chrome browser...`);

    // Setup Chrome driver (same as Seek bot)
    const { driver, sessionExists, sessionsDir } = await setupChromeDriver('indeed');

    // Store in context
    ctx.driver = driver;
    ctx.sessionExists = sessionExists;
    ctx.sessionsDir = sessionsDir;

    // Initialize humanization and session manager
    ctx.humanBehavior = new HumanBehavior(DEFAULT_HUMANIZATION);
    ctx.sessionManager = new UniversalSessionManager(driver, SessionConfigs.indeed);
    ctx.overlay = new UniversalOverlay(driver, 'Indeed');

    // Apply stealth features
    await StealthFeatures.hideWebDriver(driver);
    await StealthFeatures.randomizeUserAgent(driver);

    printLog(sessionExists ? '✅ Using existing session' : '🆕 New session created');

    // Navigate to Indeed search page
    const targetUrl = ctx.indeed_url || `${BASE_URL}/jobs`;
    printLog(`📍 Navigating to: ${targetUrl}`);

    await driver.get(targetUrl);

    // Wait for page to stabilize
    await driver.sleep(3000);

    const currentUrl = await driver.getCurrentUrl();
    const title = await driver.getTitle();

    printLog(`✅ Page loaded: ${title}`);
    printLog(`📍 Current URL: ${currentUrl}`);

    yield "homepage_opened";

  } catch (error) {
    printLog(`❌ Homepage opening failed: ${error}`);
    yield "homepage_failed";
  }
}

/**
 * Step 2: Detect Page State
 *
 * Check if user is logged in or needs to sign in
 */
export async function* detectPageState(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    printLog(`🔍 Detecting page state...`);

    if (!ctx.driver) {
      printLog(`❌ No driver available`);
      yield "page_state_failed";
      return;
    }

    // Wait a moment for page to settle
    await ctx.driver.sleep(2000);

    // CRITICAL: Check URL first - most reliable indicator
    const currentUrl = await ctx.driver.getCurrentUrl();
    printLog(`📍 Current URL: ${currentUrl}`);

    // If on auth/login page, definitely need to sign in
    if (currentUrl.includes('/auth') ||
        currentUrl.includes('/login') ||
        currentUrl.includes('secure.indeed.com')) {
      printLog(`🔓 Sign-in required (on auth page)`);
      yield "sign_in_required";
      return;
    }

    // Check page source for sign-in indicators
    const pageSource = await ctx.driver.getPageSource();

    const hasSignInLink = pageSource.includes('Sign in') ||
                         pageSource.includes('data-tn-element="header-signin-link"') ||
                         pageSource.includes('/account/login');

    const hasAccountMenu = pageSource.includes('gnav-AccountMenu') ||
                           pageSource.includes('np-dropdown') ||
                           (pageSource.includes('/account') && !hasSignInLink);

    printLog(`🔐 Sign-in indicators found: ${hasSignInLink}`);
    printLog(`👤 Account menu found: ${hasAccountMenu}`);

    if (hasAccountMenu && !hasSignInLink) {
      printLog(`✅ User is logged in`);
      yield "logged_in";
    } else {
      printLog(`🔓 Sign-in required`);
      yield "sign_in_required";
    }

  } catch (error) {
    printLog(`❌ Page state detection failed: ${error}`);
    yield "page_state_failed";
  }
}

/**
 * Step 3: Show Sign-In Overlay
 *
 * Display overlay prompting user to manually sign in
 */
export async function* showSignInOverlay(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    printLog(`🔐 Showing sign-in overlay...`);

    if (!ctx.overlay || !ctx.driver) {
      printLog(`❌ Overlay or driver not available`);
      yield "overlay_failed";
      return;
    }

    // Show sign-in overlay (this will wait for user to click continue)
    await ctx.overlay.showSignInOverlay();

    // Navigate back to search page after sign-in
    if (ctx.indeed_url) {
      await ctx.driver.get(ctx.indeed_url);
      await ctx.driver.sleep(2000);
    }

    printLog(`✅ Sign-in complete, continuing...`);
    yield "signin_complete";

  } catch (error) {
    printLog(`❌ Sign-in overlay error: ${error}`);
    yield "overlay_failed";
  }
}

/**
 * Step 4: Collect Job Cards
 *
 * Extract job cards from the search results page
 */
export async function* collectJobCards(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    printLog(`📋 Collecting job cards...`);

    if (!ctx.driver || !ctx.selectors) {
      printLog(`❌ Driver or selectors not available`);
      yield "cards_collect_failed";
      return;
    }

    // Wait for job results to load
    await ctx.driver.sleep(2000);

    // Try multiple selectors for job cards
    const jobCardSelectors = ctx.selectors.jobs?.job_card_selectors || [
      'div[data-testid="slider_item"]',
      '.job_seen_beacon',
      'div[class*="result"]'
    ];

    let jobCards: any[] = [];

    for (const selector of jobCardSelectors) {
      try {
        const cards = await ctx.driver.findElements(By.css(selector));
        if (cards.length > 0) {
          jobCards = cards;
          printLog(`✅ Found ${cards.length} job cards using selector: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }

    if (jobCards.length === 0) {
      printLog(`❌ No job cards found`);
      yield "no_cards_found";
      return;
    }

    // Store in context
    ctx.job_cards = jobCards;
    ctx.job_index = 0;
    ctx.total_jobs = jobCards.length;
    ctx.applied_jobs = 0;
    ctx.skipped_jobs = 0;

    // Show initial progress overlay
    if (ctx.overlay) {
      await ctx.overlay.showJobProgress(0, jobCards.length, "Jobs collected", 4);
    }

    printLog(`✅ Collected ${jobCards.length} job cards`);
    yield "cards_collected";

  } catch (error) {
    printLog(`❌ Job card collection failed: ${error}`);
    yield "cards_collect_failed";
  }
}

/**
 * Step 5: Click Job Card
 *
 * Click on a job card to view details
 */
export async function* clickJobCard(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const cards = ctx.job_cards || [];
    const index = ctx.job_index || 0;

    if (!ctx.driver) {
      printLog(`❌ Driver not available`);
      yield "click_failed";
      return;
    }

    // Check if we've processed all cards
    if (index >= cards.length) {
      printLog(`✅ All job cards processed`);
      yield "cards_finished";
      return;
    }

    printLog(`🖱️ Clicking job card ${index + 1}/${cards.length}...`);

    try {
      const card = cards[index];

      // Scroll card into view
      await ctx.driver.executeScript("arguments[0].scrollIntoView(true);", card);

      // Wait a moment for any animations
      await ctx.driver.sleep(500);

      // Click the card
      await card.click();

      // Wait for job details to load
      await ctx.driver.sleep(2000);

      // Update index
      ctx.job_index = index + 1;

      printLog(`✅ Job card clicked successfully`);
      yield "card_clicked";

    } catch (cardError) {
      printLog(`⚠️ Failed to click card ${index + 1}, skipping: ${cardError}`);

      // Skip this card and move to next
      ctx.job_index = index + 1;
      yield "card_skipped";
    }

  } catch (error) {
    printLog(`❌ Click job card error: ${error}`);
    yield "click_failed";
  }
}

// Export step functions for workflow engine
export const indeedStepFunctions = {
  step0,
  openHomepage,
  detectPageState,
  showSignInOverlay,
  collectJobCards,
  clickJobCard,
};
