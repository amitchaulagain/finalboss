import { WebDriver, By, until, Key } from 'selenium-webdriver';
import { setupChromeDriver } from '../core/browser_manager';
import { HumanBehavior, StealthFeatures, DEFAULT_HUMANIZATION } from '../core/humanization';
import { UniversalSessionManager, SessionConfigs } from '../core/sessionManager';
import { UniversalOverlay } from '../core/universal_overlay';
import type { WorkflowContext } from '../core/workflow_engine';
import { recordJobApplicationToBackend } from '../core/job_application_recorder';
import { getJobArtifactDir, getClientEmailFromContext } from '../core/client_paths';
import { logger } from '../core/logger';
import { getIntelligentAnswers } from '../seek/handlers/intelligent_qa_handler';
import { fillQuestionFieldDetailed } from '../seek/handlers/answer_employer_questions';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const printLog = (message: string) => {
  console.log(message);
};

// #region agent log
const DEBUG_LOG = (location: string, message: string, data: Record<string, unknown>, hypothesisId: string) => {
  const payload = { location, message, data, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId };
  fetch('http://127.0.0.1:7242/ingest/e1922693-d436-4aba-b2d8-ded81d139fea', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
  try {
    const line = JSON.stringify(payload) + '\n';
    const logDir = path.join(process.cwd(), '.cursor');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'debug.log'), line);
    fs.appendFileSync(path.join(__dirname, 'linkedin-debug.log'), line);
  } catch (_) {}
};
// #endregion

/**
 * Dismiss common LinkedIn overlays (cookie banner, modals) that block the search form.
 */
async function dismissLinkedInOverlays(driver: WebDriver): Promise<void> {
  const dismissSelectors = [
    "button[data-test-id='dialog-primary-action-btn']", // LinkedIn dialog primary action
    "button[aria-label='Dismiss']",
    "button[aria-label='Close']",
    ".artdeco-modal__dismiss",
    "button.artdeco-modal__dismiss",
    "[data-test-modal-close-btn]",
    "//button[contains(., 'Accept') or contains(., 'Reject') or contains(., 'Accept all') or contains(., 'Reject all')]",
    "//button[contains(., 'Dismiss') or contains(., 'Got it') or contains(., 'Maybe later')]"
  ];
  for (const sel of dismissSelectors) {
    try {
      const el = sel.startsWith('//') ? await driver.findElement(By.xpath(sel)) : await driver.findElement(By.css(sel));
      if (el) {
        await el.click();
        await driver.sleep(500);
        printLog(`Dismissed overlay via: ${sel.substring(0, 50)}...`);
      }
    } catch {
      // Element not present, continue
    }
  }
}

/**
 * Wait for the jobs page search form to be present and ready, dismiss overlays if needed.
 */
async function waitForJobsSearchFormReady(driver: WebDriver, selectors: { jobs?: { keywords_input_candidates?: string[]; location_input_candidates?: string[] } }): Promise<boolean> {
  const keywordCandidates = selectors?.jobs?.keywords_input_candidates ?? [];
  const locationCandidates = selectors?.jobs?.location_input_candidates ?? [];
  const allCandidates = [...keywordCandidates, ...locationCandidates];
  const maxAttempts = 6;
  const attemptDelay = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Dismiss overlays that might be covering the form
    await dismissLinkedInOverlays(driver);

    for (const selector of allCandidates) {
      try {
        const el = await driver.wait(until.elementLocated(By.css(selector)), 3000);
        const isDisplayed = await el.isDisplayed();
        if (el && isDisplayed) {
          printLog(`Jobs search form ready (attempt ${attempt}): found ${selector.substring(0, 50)}`);
          return true;
        }
      } catch {
        continue;
      }
    }

    if (attempt < maxAttempts) {
      printLog(`Search form not ready, attempt ${attempt}/${maxAttempts}, waiting...`);
      await driver.sleep(attemptDelay);
    }
  }
  return false;
}

// Step 0: Initialize Context - Load config, selectors, and job IDs
export async function* step0(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    // #region agent log
    DEBUG_LOG('linkedin_impl.ts:step0', 'step0 entered', { cwd: process.cwd(), __dirname }, 'H1');
    // #endregion
    const selectorsConfigPath = path.join(__dirname, 'config/linkedin_selectors.json');
    const selectorsRootPath = path.join(__dirname, 'linkedin_selectors.json');
    const selectorsPath = fs.existsSync(selectorsConfigPath) ? selectorsConfigPath : selectorsRootPath;
    ctx.selectors = JSON.parse(fs.readFileSync(selectorsPath, 'utf-8'));

    const configPath = path.join(__dirname, '../user-bots-config.json');
    if (fs.existsSync(configPath)) {
      ctx.config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } else {
      ctx.config = {};
    }

    const jobIdsPath = path.join(process.cwd(), 'deknilJobsIds.json');
    let jobIds: Set<string> = new Set();

    if (fs.existsSync(jobIdsPath)) {
      const data = JSON.parse(fs.readFileSync(jobIdsPath, 'utf-8'));
      jobIds = new Set(Array.isArray(data) ? data : []);
    }

    ctx.applied_job_ids = jobIds;

    // #region agent log
    DEBUG_LOG('linkedin_impl.ts:step0', 'Context ready', { hasFormData: !!ctx.config?.formData, locations: ctx.config?.formData?.locations ?? null, keywords: ctx.config?.formData?.keywords ?? null, locationInputCandidates: (ctx.selectors?.jobs?.location_input_candidates ?? []).length, keywordInputCandidates: (ctx.selectors?.jobs?.keywords_input_candidates ?? []).length }, 'H1');
    // #endregion
    yield "ctx_ready";
  } catch (error) {
    yield "ctx_failed";
  }
}

// Open LinkedIn and check login status
export async function* openCheckLogin(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    // Only setup Chrome if driver doesn't exist yet
    if (!ctx.driver) {
      const { driver, sessionExists, sessionsDir } = await setupChromeDriver('linkedin');
      ctx.driver = driver;
      ctx.sessionExists = sessionExists;
      ctx.sessionsDir = sessionsDir;
      ctx.humanBehavior = new HumanBehavior(DEFAULT_HUMANIZATION);
      ctx.sessionManager = new UniversalSessionManager(driver, SessionConfigs.linkedin);
      ctx.overlay = new UniversalOverlay(driver, 'LinkedIn');

      await StealthFeatures.hideWebDriver(driver);
      await StealthFeatures.randomizeUserAgent(driver);
    }

    const jobsUrl = ctx.selectors?.urls?.jobs_url || 'https://www.linkedin.com/jobs/';

    // Check current URL first - don't navigate if already on LinkedIn
    let currentUrl = await ctx.driver.getCurrentUrl();

    if (!currentUrl.includes('linkedin.com') || currentUrl === 'data:,') {
      printLog(`Navigating to: ${jobsUrl}`);
      await ctx.driver.get(jobsUrl);
      await ctx.driver.sleep(2000);
      currentUrl = await ctx.driver.getCurrentUrl();
    } else {
      printLog(`Already on LinkedIn: ${currentUrl}`);
    }

    const title = await ctx.driver.getTitle();
    printLog(`Current URL: ${currentUrl}`);
    printLog(`Page title: ${title}`);

    // Check if we're on the jobs page (logged in) or redirected to login
    if (currentUrl.includes('/login') || currentUrl.includes('/uas/login')) {
      printLog("Redirected to login - user needs to log in");
      yield "user_needs_to_login";
      return;
    }

    // Check if we're on jobs page (indicates logged in)
    if (currentUrl.includes('/jobs')) {
      printLog("Already on jobs page - logged in");
      yield "login_not_needed";
      return;
    }

    // Check for sign-in indicators in page content
    const pageSource = await ctx.driver.getPageSource();
    if (pageSource.includes('Sign in') || pageSource.includes('Join now')) {
      printLog("Sign-in indicators found - user needs to log in");
      yield "user_needs_to_login";
    } else {
      printLog("Login status unclear, proceeding");
      yield "cannot_determine_login_status";
    }
  } catch (error) {
    printLog(`Error checking login: ${error}`);
    yield "failed_to_navigate";
  }
}

// Attempt credential login (skipped - users login manually like Seek)
export async function* credentialLogin(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  printLog("Skipping credential login - users login manually");

  // Always skip to manual login since users login manually like Seek
  printLog("Proceeding to manual login prompt");
  yield "no_login_credentials_found";
}

// Show manual login prompt
export async function* showManualLoginPrompt(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  printLog("Showing manual login prompt");

  try {
    await ctx.overlay.showSignInOverlay();
    printLog("Manual login prompt shown");
    yield "prompt_displayed_to_user";
  } catch (error) {
    printLog(`Error showing manual login prompt: ${error}`);
    yield "error_showing_manual_login";
  }
}

// Open jobs page (navigate to search URL when keywords/location set so search bar is present)
export async function* openJobsPage(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const driver = ctx.driver;
    const selectors = ctx.selectors;
    const keywords = (ctx.config?.formData?.keywords || '').trim();
    const location = (ctx.config?.formData?.locations || '').trim();
    const baseSearchUrl = selectors?.urls?.jobs_search_url || 'https://www.linkedin.com/jobs/search/';
    const jobsHomeUrl = selectors?.urls?.jobs_url || 'https://www.linkedin.com/jobs/';

    let targetUrl: string;
    if (keywords) {
      const params = new URLSearchParams();
      params.set('keywords', keywords);
      if (location) params.set('location', location);
      targetUrl = `${baseSearchUrl}?${params.toString()}`;
    } else {
      targetUrl = jobsHomeUrl;
    }

    const currentUrl = await driver.getCurrentUrl();
    const alreadyOnSearch = currentUrl.includes('/jobs/search') && (keywords ? currentUrl.includes(encodeURIComponent(keywords)) : true);
    if (!currentUrl.includes('/jobs') || !alreadyOnSearch) {
      printLog(`Navigating to: ${targetUrl}`);
      await driver.get(targetUrl);
      await driver.sleep(3000);
    }

    // Wait for search form to be present and dismiss any overlays blocking it
    const formReady = await waitForJobsSearchFormReady(driver, selectors);
    if (!formReady) {
      printLog("Warning: Search form not found after waiting; proceeding anyway.");
    }

    await ctx.overlay.showJobProgress(0, 0, "Initializing LinkedIn bot...", 5);

    yield "jobs_page_loaded";
  } catch (error) {
    yield "failed_opening_jobs_page";
  }
}

// Set search location
export async function* setSearchLocation(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const driver = ctx.driver;
    const selectors = ctx.selectors;

    const location = ctx.config.formData?.locations || '';

    // #region agent log
    DEBUG_LOG('linkedin_impl.ts:setSearchLocation', 'Entry', { location, locationLength: location.length }, 'H1');
    // #endregion
    if (!location) {
      // #region agent log
      DEBUG_LOG('linkedin_impl.ts:setSearchLocation', 'Yield no_search_location_in_settings', { yielded: 'no_search_location_in_settings' }, 'H1');
      // #endregion
      yield "no_search_location_in_settings";
      return;
    }

    // Check if URL already contains location parameter - if so, skip filling form
    try {
      const currentUrl = await driver.getCurrentUrl();
      const urlObj = new URL(currentUrl);
      const urlLocation = urlObj.searchParams.get('location');
      if (urlLocation && urlLocation.toLowerCase().includes(location.toLowerCase())) {
        printLog(`Location already in URL: ${urlLocation}, skipping form fill`);
        ctx.search_location = location;
        if (ctx.overlay) await ctx.overlay.showJobProgress(0, 0, "Location already set via URL", 7).catch(() => {});
        // #region agent log
        DEBUG_LOG('linkedin_impl.ts:setSearchLocation', 'Location already in URL, skipping', { urlLocation, yielded: 'search_location_set' }, 'H1');
        // #endregion
        yield "search_location_set";
        return;
      }
    } catch (error) {
      // URL parsing failed, continue to form filling
    }

    // Hide overlay so it does not block interaction; dismiss any LinkedIn overlays
    if (ctx.overlay) await ctx.overlay.hideOverlay().catch(() => {});
    await dismissLinkedInOverlays(driver);
    await driver.sleep(500);

    const locationSelectors = selectors.jobs?.location_input_candidates || [];
    const locationXpaths = [
      "//input[contains(@aria-label,'City') or contains(@aria-label,'Location') or contains(@placeholder,'City') or contains(@placeholder,'Location')]",
      "//input[@role='combobox' and (contains(@aria-label,'location') or contains(@placeholder,'location'))]"
    ];

    for (let idx = 0; idx < locationSelectors.length; idx++) {
      const selector = locationSelectors[idx];
      try {
        const locationInput = await driver.wait(until.elementLocated(By.css(selector)), 10000);
        await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", locationInput);
        await driver.sleep(300);
        await locationInput.click();
        await driver.sleep(500);
        await locationInput.sendKeys(Key.CONTROL, 'a');
        await locationInput.sendKeys(Key.DELETE);
        await locationInput.sendKeys(location);
        await driver.sleep(1000);
        await locationInput.sendKeys(Key.ENTER);

        printLog(`Location: ${location}`);
        ctx.search_location = location;
        if (ctx.overlay) await ctx.overlay.showJobProgress(0, 0, "Location set", 7).catch(() => {});
        // #region agent log
        DEBUG_LOG('linkedin_impl.ts:setSearchLocation', 'Location set', { selectorIndex: idx, yielded: 'search_location_set' }, 'H2');
        // #endregion
        yield "search_location_set";
        return;
      } catch (error) {
        // #region agent log
        DEBUG_LOG('linkedin_impl.ts:setSearchLocation', 'Selector failed', { selectorIndex: idx, selector: selector.substring(0, 60), error: String((error as Error)?.message ?? error) }, 'H2');
        // #endregion
        continue;
      }
    }
    for (let idx = 0; idx < locationXpaths.length; idx++) {
      try {
        const locationInput = await driver.wait(until.elementLocated(By.xpath(locationXpaths[idx])), 5000);
        await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", locationInput);
        await driver.sleep(300);
        await locationInput.click();
        await driver.sleep(500);
        await locationInput.sendKeys(Key.CONTROL, 'a');
        await locationInput.sendKeys(Key.DELETE);
        await locationInput.sendKeys(location);
        await driver.sleep(1000);
        await locationInput.sendKeys(Key.ENTER);
        printLog(`Location (XPath): ${location}`);
        ctx.search_location = location;
        if (ctx.overlay) await ctx.overlay.showJobProgress(0, 0, "Location set", 7).catch(() => {});
        // #region agent log
        DEBUG_LOG('linkedin_impl.ts:setSearchLocation', 'Location set via XPath', { xpathIndex: idx, yielded: 'search_location_set' }, 'H2');
        // #endregion
        yield "search_location_set";
        return;
      } catch (error) {
        continue;
      }
    }

    // Location input not found - yield outcome that transitions to set_search_keywords (so we always proceed without requiring YAML change / restart)
    if (ctx.overlay) await ctx.overlay.showJobProgress(0, 0, "Location not set", 7).catch(() => {});
    // #region agent log
    DEBUG_LOG('linkedin_impl.ts:setSearchLocation', 'Yield no_search_location_in_settings (proceed to keywords)', { yielded: 'no_search_location_in_settings' }, 'H2');
    // #endregion
    yield "no_search_location_in_settings";
  } catch (error) {
    if (ctx.overlay) await ctx.overlay.showJobProgress(0, 0, "Error setting location", 7).catch(() => {});
    yield "failed_setting_search_location";
  }
}

// Set search keywords
export async function* setSearchKeywords(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const driver = ctx.driver;
    const selectors = ctx.selectors;

    const keywords = ctx.config.formData?.keywords || '';

    // #region agent log
    DEBUG_LOG('linkedin_impl.ts:setSearchKeywords', 'Entry', { keywords, keywordsLength: keywords.length }, 'H1');
    // #endregion
    if (!keywords) {
      yield "no_keywords_in_settings";
      return;
    }

    // Check if URL already contains keywords parameter - if so, skip filling form
    try {
      const currentUrl = await driver.getCurrentUrl();
      const urlObj = new URL(currentUrl);
      const urlKeywords = urlObj.searchParams.get('keywords');
      if (urlKeywords && urlKeywords.toLowerCase().includes(keywords.toLowerCase())) {
        printLog(`Keywords already in URL: ${urlKeywords}, skipping form fill`);
        ctx.search_keywords = keywords;
        if (ctx.overlay) await ctx.overlay.showJobProgress(0, 0, "Keywords already set via URL", 6).catch(() => {});
        // #region agent log
        DEBUG_LOG('linkedin_impl.ts:setSearchKeywords', 'Keywords already in URL, skipping', { urlKeywords, yielded: 'search_keywords_set' }, 'H1');
        // #endregion
        yield "search_keywords_set";
        return;
      }
    } catch (error) {
      // URL parsing failed, continue to form filling
    }

    // Hide overlay so it does not block interaction; dismiss any LinkedIn overlays
    if (ctx.overlay) await ctx.overlay.hideOverlay().catch(() => {});
    await dismissLinkedInOverlays(driver);
    await driver.sleep(500);

    const keywordSelectors = selectors.jobs?.keywords_input_candidates || [];

    // Wait for search box to be present (results load asynchronously after opening jobs page)
    for (let idx = 0; idx < keywordSelectors.length; idx++) {
      const selector = keywordSelectors[idx];
      try {
        const keywordsInput = await driver.wait(until.elementLocated(By.css(selector)), 10000);
        await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", keywordsInput);
        await driver.sleep(300);
        await keywordsInput.click();
        await driver.sleep(500);
        await keywordsInput.sendKeys(Key.CONTROL, 'a');
        await keywordsInput.sendKeys(Key.DELETE);
        await keywordsInput.sendKeys(keywords);
        await driver.sleep(800);
        await keywordsInput.sendKeys(Key.ENTER);
        await driver.sleep(4000); // wait for search results to load

        printLog(`Keywords: ${keywords}`);
        ctx.search_keywords = keywords;
        if (ctx.overlay) await ctx.overlay.showJobProgress(0, 0, "Keywords set", 6).catch(() => {});
        // #region agent log
        DEBUG_LOG('linkedin_impl.ts:setSearchKeywords', 'Keywords set', { selectorIndex: idx, yielded: 'search_keywords_set' }, 'H2');
        // #endregion
        yield "search_keywords_set";
        return;
      } catch (error) {
        // #region agent log
        DEBUG_LOG('linkedin_impl.ts:setSearchKeywords', 'Selector failed', { selectorIndex: idx, selector: selector.substring(0, 60), error: String((error as Error)?.message ?? error) }, 'H2');
        // #endregion
        continue;
      }
    }

    if (ctx.overlay) await ctx.overlay.showJobProgress(0, 0, "Keywords input not found", 6).catch(() => {});
    // #region agent log
    DEBUG_LOG('linkedin_impl.ts:setSearchKeywords', 'Yield keywords_input_not_found', { yielded: 'keywords_input_not_found' }, 'H2');
    // #endregion
    yield "keywords_input_not_found";
  } catch (error) {
    if (ctx.overlay) await ctx.overlay.showJobProgress(0, 0, "Error setting keywords", 6).catch(() => {});
    yield "failed_setting_search_keywords";
  }
}

// Apply filters
export async function* applyFilters(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {

  try {
    const driver = ctx.driver;
    const selectors = ctx.selectors?.jobs;

    await driver.sleep(2000);

    // Try to find and click "All filters" button (CSS from live DOM: search-reusables__all-filters-pill-button)
    try {
      // #region agent log
      DEBUG_LOG('linkedin_impl.ts:applyFilters', 'Before All filters', {}, 'H4');
      // #endregion
      let allFiltersButton;
      const allFiltersCss = selectors?.all_filters_button?.css;
      const allFiltersXpath = selectors?.all_filters_button?.xpath || "//button[normalize-space()='All filters']";
      try {
        if (allFiltersCss) allFiltersButton = await driver.findElement(By.css(allFiltersCss));
        else throw new Error('no css');
      } catch {
        allFiltersButton = await driver.findElement(By.xpath(allFiltersXpath));
      }
      await allFiltersButton.click();
      await driver.sleep(2000);

      // Apply location in the filters modal only if URL does not already have location (avoid re-editing)
      const location = (ctx.config.formData?.locations || '').trim();
      let urlAlreadyHasLocation = false;
      if (location) {
        try {
          const currentUrl = await driver.getCurrentUrl();
          const urlObj = new URL(currentUrl);
          const urlLocation = urlObj.searchParams.get('location');
          urlAlreadyHasLocation = !!(urlLocation && urlLocation.toLowerCase().includes(location.toLowerCase()));
        } catch {
          // ignore
        }
      }
      if (location && !urlAlreadyHasLocation) {
        const locationInputXpaths = [
          "//input[contains(@aria-label,'City') or contains(@aria-label,'Location') or contains(@placeholder,'City') or contains(@placeholder,'Location')]",
          "//input[@role='combobox' and (contains(@aria-label,'location') or contains(@placeholder,'location'))]",
          "//label[contains(.,'Location') or contains(.,'City')]/following::input[1]",
          "//*[contains(text(),'Location') or contains(text(),'City')]/following::input[1]"
        ];
        for (const xpath of locationInputXpaths) {
          try {
            const locationInput = await driver.findElement(By.xpath(xpath));
            await locationInput.click();
            await driver.sleep(300);
            await locationInput.sendKeys(Key.CONTROL, 'a');
            await locationInput.sendKeys(Key.DELETE);
            await locationInput.sendKeys(location);
            await driver.sleep(800);
            await locationInput.sendKeys(Key.ENTER);
            printLog(`Filters: location set to ${location}`);
            break;
          } catch {
            continue;
          }
        }
      }

      // Click Easy Apply filter if configured
      if (ctx.config.formData?.easyApplyOnly) {
        try {
          const easyApplyButton = await driver.findElement(By.xpath('//button[contains(text(), "Easy Apply")]'));
          await easyApplyButton.click();
          await driver.sleep(1000);
        } catch (error) {
          // Filter not available
        }
      }

      // Click "Show results" button
      try {
        const showResultsCss = selectors?.show_results_button?.css || 'button[aria-label*="Apply current filters"]';
        const showResultsButton = await driver.findElement(By.css(showResultsCss));
        await showResultsButton.click();
        await driver.sleep(3000);
      } catch (error) {
        // Continue without filters
      }

      // #region agent log
      DEBUG_LOG('linkedin_impl.ts:applyFilters', 'Filters applied', { yielded: 'filters_applied_successfully' }, 'H4');
      // #endregion
      yield "filters_applied_successfully";
    } catch (error) {
      // All filters not found or modal not present - still proceed so job list can load (preferred job already set by keywords/location)
      // #region agent log
      DEBUG_LOG('linkedin_impl.ts:applyFilters', 'All filters failed (proceeding)', { error: String((error as Error)?.message ?? error), yielded: 'filters_applied_successfully' }, 'H4');
      // #endregion
      yield "filters_applied_successfully";
    }
  } catch (error) {
    yield "filters_application_failed";
  }
}

// Get page info
export async function* getPageInfo(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {

  try {
    const driver = ctx.driver;

    // Try to detect pagination
    try {
      const paginationContainer = await driver.findElement(By.css('ul.artdeco-pagination__pages'));
      const activeButton = await paginationContainer.findElement(By.css('button[aria-current="page"]'));
      const pageText = await activeButton.getText();
      const currentPage = parseInt(pageText) || 1;

      ctx.has_pagination = true;
      ctx.pagination_current_page = currentPage;
    } catch (error) {
      ctx.has_pagination = false;
      ctx.pagination_current_page = 1;
    }

    yield "page_info_extracted";
  } catch (error) {
    yield "failed_extracting_page_info";
  }
}

// Extract job details
export async function* extractJobDetails(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const driver = ctx.driver;

    await driver.sleep(2000);

    // Wait for job list to load (up to 15s) then find job cards
    let jobCards: Awaited<ReturnType<WebDriver['findElements']>>;
    try {
      await driver.wait(until.elementsLocated(By.css('li[data-occludable-job-id]')), 15000);
      jobCards = await driver.findElements(By.css('li[data-occludable-job-id]'));
    } catch {
      jobCards = [];
    }
    // Fallback: LinkedIn sometimes uses different list structure
    if (jobCards.length === 0) {
      jobCards = await driver.findElements(By.css('li[data-job-id]'));
    }
    if (jobCards.length === 0) {
      const jobLinks = await driver.findElements(By.css('a[href*="/jobs/view/"]'));
      if (jobLinks.length > 0) {
        const listItems: Awaited<ReturnType<WebDriver['findElements']>> = [];
        for (const link of jobLinks) {
          try {
            const li = await link.findElement(By.xpath('./ancestor::li[1]'));
            listItems.push(li);
          } catch {
            // skip
          }
        }
        jobCards = listItems;
      }
    }

    // #region agent log
    DEBUG_LOG('linkedin_impl.ts:extractJobDetails', 'Job cards found', { jobCardsLength: jobCards.length, currentUrl: await driver.getCurrentUrl().catch(() => '') }, 'H3');
    // #endregion
    if (jobCards.length === 0) {
      // #region agent log
      DEBUG_LOG('linkedin_impl.ts:extractJobDetails', 'Yield no_job_cards_found', { yielded: 'no_job_cards_found' }, 'H3');
      // #endregion
      yield "no_job_cards_found";
      return;
    }

    printLog(`Found ${jobCards.length} jobs`);

    const extractedJobs: any[] = [];

    for (let i = 0; i < jobCards.length; i++) {
      try {
        const card = jobCards[i];

        // Scroll to card
        await driver.executeScript("arguments[0].scrollIntoView(true);", card);
        await driver.sleep(500);

        let jobId = await card.getAttribute('data-occludable-job-id') || await card.getAttribute('data-job-id');
        if (!jobId) {
          try {
            const link = await card.findElement(By.css('a[href*="/jobs/view/"]'));
            const href = await link.getAttribute('href') || '';
            const match = href.match(/\/jobs\/view\/(\d+)/);
            if (match) jobId = match[1];
          } catch {
            // skip
          }
        }
        if (!jobId) continue;

        // Extract title (primary and fallback selectors)
        let title = '';
        try {
          const titleElement = await card.findElement(By.css('a.job-card-list__title--link'));
          title = (await titleElement.getText()).trim();
        } catch {
          try {
            const titleElement = await card.findElement(By.css('a[href*="/jobs/view/"]'));
            title = (await titleElement.getText()).trim();
          } catch (error) {
            continue;
          }
        }

        // Extract company
        let company = '';
        try {
          const companyElement = await card.findElement(By.css('.artdeco-entity-lockup__subtitle span'));
          company = (await companyElement.getText()).trim();
        } catch (error) {
          // Ignore
        }

        // Extract location
        let location = '';
        try {
          const locationElement = await card.findElement(By.css('.job-card-container__metadata-wrapper li span'));
          location = (await locationElement.getText()).trim();
        } catch (error) {
          // Ignore
        }

        extractedJobs.push({
          job_id: jobId,
          title: title,
          company: company,
          work_location: location,
          is_applied: false
        });
      } catch (error) {
        continue;
      }
    }

    ctx.extracted_jobs = extractedJobs;
    ctx.total_jobs = extractedJobs.length;
    ctx.applied_jobs = 0;
    ctx.skipped_jobs = 0;
    ctx.current_job_index = 0;

    await ctx.overlay.updateJobProgress(0, extractedJobs.length, "Jobs extracted", 10);

    // #region agent log
    DEBUG_LOG('linkedin_impl.ts:extractJobDetails', 'Extract done', { extractedCount: extractedJobs.length, yielded: 'proceed_to_process_jobs' }, 'H3');
    // #endregion
    yield "proceed_to_process_jobs";
  } catch (error) {
    printLog(`Error extracting job details: ${error}`);
    // #region agent log
    DEBUG_LOG('linkedin_impl.ts:extractJobDetails', 'Extract error', { error: String((error as Error)?.message ?? error), yielded: 'failed_extracting_jobs' }, 'H3');
    // #endregion
    yield "failed_extracting_jobs";
  }
}

// Process jobs
export async function* processJobs(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  const extractedJobs = ctx.extracted_jobs || [];

  if (extractedJobs.length === 0) {
    yield "no_jobs_to_process";
    return;
  }

  ctx.current_job = extractedJobs[0];
  ctx.current_job_index = 0;

  yield "starting_to_process_jobs";
}

// Attempt Easy Apply
export async function* attemptEasyApply(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const driver = ctx.driver;
    const currentJob = ctx.current_job;

    if (!currentJob) {
      yield "no_job_to_process";
      return;
    }

    const jobId = currentJob.job_id;
    const jobTitle = currentJob.title;
    const company = currentJob.company;

    printLog(`Processing: ${jobTitle}`);

    // Click on the job card to load details
    try {
      const jobCard = await driver.findElement(By.css(`[data-occludable-job-id="${jobId}"]`));
      await jobCard.click();
      await driver.sleep(2000);
    } catch (error) {
      yield "job_card_not_found";
      return;
    }

    // Look for Easy Apply button - check button text to differentiate from regular Apply
    const easyApplySelectors = ctx.selectors?.easy_apply?.button_css_candidates || [
      'button#jobs-apply-button-id',
      'button.jobs-apply-button'
    ];

    let easyApplyButton = null;

    for (const selector of easyApplySelectors) {
      try {
        const button = await driver.findElement(By.css(selector));
        const buttonText = await button.getText();

        // Only accept if it's "Easy Apply", not just "Apply"
        if (buttonText.includes('Easy Apply')) {
          easyApplyButton = button;
          break;
        }
      } catch (error) {
        continue;
      }
    }

    if (easyApplyButton) {
      try {
        await easyApplyButton.click();
        await driver.sleep(2000);

        // Check if the Easy Apply modal opened
        try {
          const modal = await driver.findElement(By.css('div.jobs-easy-apply-modal'));

          // Check for initial profile setup form inside modal
          try {
            const modalHtml = await modal.getAttribute('innerHTML');
            if (modalHtml.includes('Be sure to include an updated resume') ||
                modalHtml.includes('Upload resume') ||
                modalHtml.includes('DOC, DOCX, PDF')) {

              printLog('⚠️ PROFILE SETUP REQUIRED');
              await ctx.overlay.showMessage(
                '⚠️ PROFILE SETUP REQUIRED ⚠️',
                'LinkedIn needs you to:\n\n1. Fill in contact info\n2. Upload resume\n3. Click Next\n4. Then click Continue here',
                'error'
              );

              yield "modal_failed_to_open";
              return;
            }
          } catch (innerError) {
            // No profile setup form found, continue
          }

          await ctx.overlay.updateJobProgress(
            ctx.applied_jobs || 0,
            ctx.total_jobs || 0,
            `Applying: ${jobTitle}`,
            14
          );

          yield "modal_opened_successfully";
        } catch (error) {
          yield "modal_failed_to_open";
        }
      } catch (error) {
        yield "failed_to_click_easy_apply";
      }
    } else {
      yield "no_easy_apply_button_found";
    }
  } catch (error) {
    yield "easy_apply_process_error";
  }
}

// Extract job details from the job details panel and save to JSON
export async function* extractJobDetailsFromPanel(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const driver = ctx.driver;
    const currentJob = ctx.current_job;

    if (!currentJob || !currentJob.job_id) {
      yield "job_details_extraction_failed";
      return;
    }

    const jobId = currentJob.job_id;
    const selectors = ctx.selectors?.jobs?.job_details_panel;

    const jobDetails: any = {
      job_id: jobId,
      extracted_at: new Date().toISOString(),
    };

    // Extract title
    try {
      const titleElement = await driver.findElement(By.css(selectors?.title_css || 'div.job-details-jobs-unified-top-card__job-title h1'));
      jobDetails.title = (await titleElement.getText()).trim();
    } catch (error) {
      jobDetails.title = currentJob.title || '';
    }

    // Extract company
    try {
      const companyElement = await driver.findElement(By.css(selectors?.company_name_css || 'div.job-details-jobs-unified-top-card__company-name a'));
      jobDetails.company = (await companyElement.getText()).trim();
    } catch (error) {
      jobDetails.company = currentJob.company || '';
    }

    // Extract location
    try {
      const locationElement = await driver.findElement(By.xpath(selectors?.location_xpath || "//div[contains(@class, 'job-details-jobs-unified-top-card__tertiary-description')]//span[contains(@class, 'tvm__text--low-emphasis')][1]"));
      jobDetails.location = (await locationElement.getText()).trim();
    } catch (error) {
      jobDetails.location = currentJob.work_location || '';
    }

    // Extract time posted
    try {
      const timeElement = await driver.findElement(By.xpath(selectors?.time_posted_xpath || "//div[contains(@class, 'job-details-jobs-unified-top-card__tertiary-description')]//span[contains(@class, 'tvm__text--positive')]//span"));
      jobDetails.time_posted = (await timeElement.getText()).trim();
    } catch (error) {
      jobDetails.time_posted = '';
    }

    // Extract applicants count
    try {
      const applicantsElement = await driver.findElement(By.xpath(selectors?.applicants_count_xpath || "//div[contains(@class, 'job-details-jobs-unified-top-card__tertiary-description')]//span[contains(text(), 'applicants')]"));
      jobDetails.applicants_count = (await applicantsElement.getText()).trim();
    } catch (error) {
      jobDetails.applicants_count = '';
    }

    // Extract job type tags (Remote, Full-time, etc.)
    try {
      const tagElements = await driver.findElements(By.css(selectors?.job_type_tags_css || 'div.job-details-fit-level-preferences button'));
      const tags = [];
      for (const tag of tagElements) {
        const tagText = (await tag.getText()).trim();
        if (tagText) tags.push(tagText);
      }
      jobDetails.job_type_tags = tags;
    } catch (error) {
      jobDetails.job_type_tags = [];
    }

    // Extract description
    try {
      const descElement = await driver.findElement(By.css(selectors?.description_text_css || 'div.jobs-box__html-content'));
      jobDetails.description = (await descElement.getText()).trim();
    } catch (error) {
      jobDetails.description = '';
    }

    // Save to file
    const jobsDir = getJobArtifactDir(ctx, 'linkedin', jobId);

    if (!fs.existsSync(jobsDir)) {
      fs.mkdirSync(jobsDir, { recursive: true });
    }

    const jobDetailsPath = path.join(jobsDir, 'job_details.json');
    const clientEmail = getClientEmailFromContext(ctx);
    if (clientEmail) {
      jobDetails.clientEmail = clientEmail;
    }
    fs.writeFileSync(jobDetailsPath, JSON.stringify(jobDetails, null, 2));

    printLog(`Saved: ${jobDetails.title} at ${jobDetails.company}`);
    ctx.current_job_details = jobDetails;
    ctx.currentJobFile = jobDetailsPath;
    ctx.currentJobDir = jobsDir;

    yield "job_details_extracted";
  } catch (error) {
    yield "job_details_extraction_failed";
  }
}

// Generate AI cover letter for LinkedIn (same API as Seek, platform: linkedin)
async function generateAICoverLetterLinkedIn(ctx: WorkflowContext): Promise<string> {
  let jobData: any = {};
  if (ctx.currentJobFile && fs.existsSync(ctx.currentJobFile)) {
    jobData = JSON.parse(fs.readFileSync(ctx.currentJobFile, 'utf-8'));
  }
  const jobId = jobData.job_id || jobData.jobId || 'unknown';
  const title = jobData.title || '';
  const company = jobData.company || '';
  const description = jobData.description || `${title} at ${company}`;

  if (!title || !company) {
    throw new Error("No job data available - cannot generate cover letter");
  }

  printLog("Generating AI cover letter for LinkedIn...");
  printLog(`📝 Job: ${title} at ${company}`);

  const resumePath = path.join(process.cwd(), 'src/bots/all-resumes/software_engineer.txt');
  const resumeText = fs.existsSync(resumePath)
    ? fs.readFileSync(resumePath, 'utf8')
    : "Experienced software developer";

  const jobDirPath = getJobArtifactDir(ctx, 'linkedin', jobId);

  const requestBody = {
    job_id: `linkedin_${jobId}`,
    job_details: description,
    resume_text: resumeText,
    useAi: "deepseek-chat",
    platform: "linkedin",
    platform_job_id: jobId,
    job_title: title,
    company,
    prompt: `Write a compelling, professional cover letter for this LinkedIn job posting.
Highlight relevant experience and skills that match the job requirements.
Keep it concise (300-400 words) and personalized to ${company}.
Focus on demonstrating value and enthusiasm for the role.`
  };

  fs.writeFileSync(
    path.join(jobDirPath, 'cover_letter_request.json'),
    JSON.stringify(requestBody, null, 2)
  );

  const { apiRequest } = await import('../core/api_client.js');
  let data: any;
  try {
    data = await apiRequest('/api/cover_letter', 'POST', requestBody);
  } catch (apiError: unknown) {
    const msg = apiError instanceof Error ? apiError.message : String(apiError);
    printLog(`❌ Cover letter API request failed: ${msg}`);
    throw new Error(`Cover letter API call failed: ${msg}`);
  }

  fs.writeFileSync(
    path.join(jobDirPath, 'cover_letter_response.json'),
    JSON.stringify(data, null, 2)
  );

  if (data && data.success === false) {
    throw new Error(`API returned error: ${(data as any).error || 'Unknown error'}`);
  }
  if (data && (data as any).cover_letter) {
    printLog(`✅ AI cover letter generated (${(data as any).cover_letter.length} chars)`);
    return (data as any).cover_letter;
  }
  throw new Error('No cover_letter field returned from API');
}

// Handle cover letter (Easy Apply modal – detect textarea, API, fill via selectors)
export async function* handleCoverLetter(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const driver = ctx.driver;
    const easyApply = ctx.selectors?.easy_apply;
    const modalCss = easyApply?.modal_container_css || "div.jobs-easy-apply-modal";
    const coverLetterCss = easyApply?.cover_letter_textarea_css;
    const coverLetterXpath = easyApply?.cover_letter_textarea_xpath || "//textarea[contains(@placeholder, 'cover letter') or contains(@aria-label, 'cover letter')]";

    let textarea: Awaited<ReturnType<WebDriver['findElement']>> | null = null;
    try {
      const modal = await driver.findElement(By.css(modalCss));
      if (coverLetterCss) {
        try {
          textarea = await modal.findElement(By.css(coverLetterCss));
        } catch {
          // try first matching part if comma-separated
          const firstCss = coverLetterCss.split(',')[0].trim();
          if (firstCss) textarea = await modal.findElement(By.css(firstCss));
        }
      }
      if (!textarea && coverLetterXpath) {
        try {
          textarea = await modal.findElement(By.xpath(coverLetterXpath));
        } catch {
          // ignore
        }
      }
    } catch {
      try {
        if (coverLetterCss) textarea = await driver.findElement(By.css(coverLetterCss.split(',')[0].trim()));
        else if (coverLetterXpath) textarea = await driver.findElement(By.xpath(coverLetterXpath));
      } catch {
        // ignore
      }
    }

    if (!textarea) {
      printLog("Cover letter textarea not found - skipping");
      yield "cover_letter_not_required";
      return;
    }

    await textarea.click();
    await driver.sleep(300);
    await textarea.clear();
    const coverLetterText = await generateAICoverLetterLinkedIn(ctx);
    if (!coverLetterText || coverLetterText.trim().length < 50) {
      yield "cover_letter_error";
      return;
    }
    await textarea.sendKeys(coverLetterText);
    await driver.sleep(1000);
    printLog("Cover letter filled");
    yield "cover_letter_filled";
  } catch (error) {
    printLog(`Cover letter error: ${error}`);
    yield "cover_letter_error";
  }
}

// Generate AI resume for LinkedIn (same API as Seek, platform: linkedin); returns path to resume file.
async function generateAIResumeLinkedIn(ctx: WorkflowContext): Promise<string> {
  let jobData: any = {};
  if (ctx.currentJobFile && fs.existsSync(ctx.currentJobFile)) {
    jobData = JSON.parse(fs.readFileSync(ctx.currentJobFile, 'utf-8'));
  }
  const jobId = jobData.job_id || jobData.jobId || 'unknown';
  const title = jobData.title || '';
  const company = jobData.company || '';
  const description = jobData.description || `${title} at ${company}`;

  if (!title || !company) {
    throw new Error("No job data available - cannot generate resume");
  }

  printLog("Generating AI resume for LinkedIn...");
  const baseResumePath = path.join(process.cwd(), 'src/bots/all-resumes/software_engineer.txt');
  const resumeText = fs.existsSync(baseResumePath)
    ? fs.readFileSync(baseResumePath, 'utf8')
    : "Experienced software developer with full stack expertise";

  const jobDirPath = getJobArtifactDir(ctx, 'linkedin', jobId);

  const requestBody = {
    job_id: `linkedin_${jobId}`,
    job_details: description,
    resume_text: resumeText,
    useAi: "deepseek-chat",
    platform: "linkedin",
    platform_job_id: jobId,
    job_title: title,
    company,
    prompt: `Tailor this resume for the LinkedIn job posting. Optimize for ATS. Highlight experience and skills that match the job requirements. Keep formatting clean and professional.`
  };

  fs.writeFileSync(path.join(jobDirPath, 'resume_request.json'), JSON.stringify(requestBody, null, 2));
  const { apiRequest } = await import('../core/api_client.js');
  const data: any = await apiRequest('/api/resume', 'POST', requestBody);
  fs.writeFileSync(path.join(jobDirPath, 'resume_response.json'), JSON.stringify(data, null, 2));

  if (!data || !data.resume) {
    throw new Error('No resume field returned from API');
  }
  const txtPath = path.join(jobDirPath, 'resume.txt');
  fs.writeFileSync(txtPath, data.resume);
  printLog(`✅ AI resume saved: ${txtPath}`);
  return txtPath;
}

// Upload resume (Easy Apply modal – use selectors; optional AI resume, else config path; no file input → resume_not_required)
export async function* uploadResume(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  printLog("Uploading resume...");

  try {
    const driver = ctx.driver;
    const selectors = ctx.selectors?.easy_apply;
    const useAiResume = !!ctx.config?.formData?.useAiResume;
    let resumePath = (ctx.config?.formData?.resumePath || '').trim();

    if (useAiResume && ctx.currentJobFile) {
      try {
        resumePath = await generateAIResumeLinkedIn(ctx);
      } catch (err) {
        printLog(`AI resume generation failed: ${err}`);
        resumePath = (ctx.config?.formData?.resumePath || '').trim();
      }
    }

    if (!resumePath || !fs.existsSync(resumePath)) {
      printLog("No resume path or file not found - will try to continue without upload");
    }

    const fileInputCss = selectors?.resume_file_input_css || "input[type='file']";
    const fileInputXpath = selectors?.resume_file_input_xpath || ".//input[@type='file']";
    const modalCss = selectors?.modal_container_css || "div.jobs-easy-apply-modal";

    let fileInput: Awaited<ReturnType<WebDriver['findElement']>> | null = null;
    try {
      try {
        const modal = await driver.findElement(By.css(modalCss));
        fileInput = await modal.findElement(By.css(fileInputCss));
      } catch {
        try {
          fileInput = await driver.findElement(By.css(fileInputCss));
        } catch {
          // ignore
        }
      }
      if (!fileInput) {
        try {
          fileInput = await driver.findElement(By.xpath(fileInputXpath));
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    if (!fileInput) {
      printLog("No file input in modal (e.g. using profile resume) - skipping upload");
      yield "resume_not_required";
      return;
    }

    if (resumePath && fs.existsSync(resumePath)) {
      await fileInput.sendKeys(resumePath);
      printLog("Resume uploaded");
      await driver.sleep(2000);
      yield "resume_uploaded_successfully";
    } else {
      printLog("No resume file to upload - continuing");
      yield "proceeding_without_resume";
    }
  } catch (error) {
    printLog(`Resume upload error: ${error}`);
    yield "proceeding_without_resume";
  }
}

// Extract employer questions from Easy Apply modal (same output shape as Seek: question, type, options, containerSelector)
export async function* extractEmployerQuestions(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const driver = ctx.driver;
    const modalCss = ctx.selectors?.easy_apply?.modal_container_css || "div.jobs-easy-apply-modal";
    const containerCss = "div[data-test-form-element]";

    await driver.sleep(1500);

    const questionsData = await driver.executeScript(`
      const modal = document.querySelector(arguments[0]);
      if (!modal) return { questionsFound: 0, questions: [] };
      const containers = Array.from(modal.querySelectorAll(arguments[1]));
      const questions = [];
      const placeholderOpts = ['Select...', 'Please select', 'Choose...', ''];

      containers.forEach((container, index) => {
        container.setAttribute('data-linkedin-q-index', String(index));
        const containerSelector = '[data-linkedin-q-index="' + index + '"]';

        let questionText = '';
        const label = container.querySelector('label');
        if (label) questionText = (label.textContent || '').trim();
        const titleSpan = container.querySelector('[data-test-form-builder-radio-button-form-component__title], .artdeco-form-element__label');
        if (!questionText && titleSpan) questionText = (titleSpan.textContent || '').trim();
        const ariaLabel = container.querySelector('input[aria-label], textarea[aria-label], select');
        if (!questionText && ariaLabel) questionText = (ariaLabel.getAttribute('aria-label') || '').trim();
        if (!questionText) questionText = 'Question ' + (index + 1);

        const selectEl = container.querySelector('select');
        if (selectEl) {
          const options = Array.from(selectEl.options)
            .map(o => (o.textContent || o.innerText || '').trim())
            .filter(t => t && !placeholderOpts.includes(t));
          questions.push({ type: 'select', question: questionText, options: options, containerSelector: containerSelector });
          return;
        }

        const textareaEl = container.querySelector('textarea');
        if (textareaEl) {
          questions.push({ type: 'textarea', question: questionText, options: [], containerSelector: containerSelector });
          return;
        }

        const textInput = container.querySelector('input[type="text"]');
        if (textInput) {
          questions.push({ type: 'text', question: questionText, options: [], containerSelector: containerSelector });
          return;
        }

        const radioFieldset = container.querySelector('fieldset[data-test-form-builder-radio-button-form-component="true"]');
        if (radioFieldset) {
          const options = Array.from(radioFieldset.querySelectorAll('input[type="radio"]'))
            .map(r => {
              const labelEl = document.querySelector('label[for="' + r.id + '"]');
              return labelEl ? (labelEl.textContent || '').trim() : r.value || '';
            })
            .filter(Boolean);
          questions.push({ type: 'radio', question: questionText, options: options, containerSelector: containerSelector });
          return;
        }

        const checkboxes = container.querySelectorAll('input[type="checkbox"]');
        if (checkboxes.length > 0) {
          const options = Array.from(checkboxes).map(cb => {
            const labelEl = document.querySelector('label[for="' + cb.id + '"]');
            return labelEl ? (labelEl.textContent || '').trim() : (cb.getAttribute('aria-label') || '').trim();
          }).filter(Boolean);
          if (options.length > 0 || checkboxes.length > 0) {
            questions.push({ type: 'checkbox', question: questionText, options: options.length ? options : ['Yes'], containerSelector: containerSelector });
          }
        }
      });

      return { questionsFound: questions.length, questions: questions };
    `, modalCss, containerCss) as { questionsFound: number; questions: Array<{ type: string; question: string; options: string[]; containerSelector: string }> };

    if (questionsData && questionsData.questionsFound > 0) {
      printLog(`Found ${questionsData.questionsFound} employer questions`);

      let existingJobData: any = {};
      if (ctx.currentJobFile && fs.existsSync(ctx.currentJobFile)) {
        try {
          existingJobData = JSON.parse(fs.readFileSync(ctx.currentJobFile, 'utf-8'));
        } catch {
          // ignore
        }
      }

      const cleanQuestions = questionsData.questions.map((q: any, idx: number) => ({
        id: idx,
        q: q.question,
        type: q.type,
        opts: q.options || [],
        containerSelector: q.containerSelector
      }));

      const updated = { ...existingJobData, questions: cleanQuestions, lastUpdated: new Date().toISOString() };
      fs.writeFileSync(ctx.currentJobFile!, JSON.stringify(updated, null, 2));
      printLog(`Saved questions to ${ctx.currentJobFile}`);
      yield "employer_questions_saved";
    } else {
      printLog("No employer questions found");
      yield "no_employer_questions";
    }
  } catch (error) {
    printLog(`Extract employer questions error: ${error}`);
    yield "employer_questions_error";
  }
}

// Answer questions (Easy Apply modal – generic + intelligent answers, fill by type via Seek fillQuestionField)
export async function* answerQuestions(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  printLog("Answering questions...");

  try {
    const driver = ctx.driver;
    (ctx as any).platform = 'linkedin';

    let questions: Array<{ question: string; type: string; options: string[]; opts?: string[]; containerSelector: string }> = [];
    if (ctx.currentJobFile && fs.existsSync(ctx.currentJobFile)) {
      try {
        const jobData = JSON.parse(fs.readFileSync(ctx.currentJobFile, 'utf-8'));
        const raw = (jobData.questions || []) as Array<{ q: string; type: string; opts?: string[]; containerSelector: string }>;
        questions = raw.map((q) => ({
          question: q.q || '',
          type: q.type || 'text',
          options: q.opts || [],
          opts: q.opts,
          containerSelector: q.containerSelector || ''
        })).filter((q) => q.question && q.containerSelector);
      } catch {
        // ignore
      }
    }

    if (questions.length > 0) {
      printLog(`Using intelligent answers for ${questions.length} questions`);
      const answeredQuestions = await getIntelligentAnswers(questions, ctx);

      const jobId = (ctx.current_job as any)?.job_id || 'unknown';
      const jobDirPath = getJobArtifactDir(ctx, 'linkedin', jobId);
      const qnaResults: any[] = [];

      printLog("--- Questions and answers ---");
      for (let i = 0; i < answeredQuestions.length; i++) {
        const q = answeredQuestions[i];
        let answer: number | string | string[] | null = null;
        if (q.type === 'select' && typeof q.selectedAnswer === 'number') {
          answer = q.selectedAnswer;
        } else if (q.type === 'radio' && typeof q.selectedAnswer === 'number') {
          answer = q.selectedAnswer;
        } else if ((q.type === 'text' || q.type === 'textarea') && q.textAnswer) {
          answer = q.textAnswer;
        } else if (q.type === 'checkbox' && Array.isArray(q.selectedAnswer)) {
          answer = q.selectedAnswer;
        }

        let answerDisplay: string;
        if (answer === null || answer === undefined) {
          answerDisplay = "(skipped)";
        } else if (typeof answer === 'number' && (q.type === 'select' || q.type === 'radio') && Array.isArray(q.options)) {
          answerDisplay = q.options[answer] ?? String(answer);
        } else if (Array.isArray(answer)) {
          answerDisplay = answer.join(", ");
        } else {
          answerDisplay = String(answer);
        }
        const source = (q as any).answerSource || "unknown";
        printLog(`Q${i + 1} [${q.type}] ${q.question}`);
        printLog(`    Answer: ${answerDisplay} [${source}]`);
        logger.debug('linkedin.qa.answer_resolved', 'Resolved LinkedIn answer before filling', {
          index: i,
          question: q.question,
          type: q.type,
          source,
          answer,
          answerDisplay,
          containerSelector: q.containerSelector,
          options: q.options || q.opts || []
        });

        if (answer !== null && answer !== undefined) {
          const modalScope = "[data-test-modal-id='easy-apply-modal']";
          const fillResult = await fillQuestionFieldDetailed(ctx, q.containerSelector, q.type, answer, modalScope);
          const filled = fillResult.success;
          const options = q.options || q.opts || [];
          const selected =
            q.type === 'select' || q.type === 'radio'
              ? (typeof answer === 'number' ? answer : null)
              : q.type === 'checkbox'
                ? (Array.isArray(answer) ? answer : [answer])
                : null;
          const resolvedAnswer =
            typeof answer === 'number' && Array.isArray(options) && options[answer] != null
              ? String(options[answer])
              : Array.isArray(answer)
                ? answer.map((x: unknown) => String(x)).join(', ')
                : String(answer);
          qnaResults.push({
            question: q.question,
            type: q.type,
            options,
            selected,
            answer: resolvedAnswer,
            answerSource: (q as any).answerSource,
            status: filled ? 'success' : 'failed',
            failureReason: filled ? undefined : fillResult.failureReason,
            fillError: filled ? undefined : fillResult.error
          });
          printLog(`    Filled: ${filled ? "yes" : "no"}`);
          logger[filled ? 'info' : 'warn'](
            'linkedin.qa.fill_result',
            filled ? 'LinkedIn question filled successfully' : 'LinkedIn question fill failed',
            {
              index: i,
              question: q.question,
              type: q.type,
              containerSelector: q.containerSelector,
              resolvedAnswer,
              selected,
              options,
              failureReason: fillResult.failureReason,
              fillError: fillResult.error
            }
          );
        } else {
          logger.warn('linkedin.qa.answer_skipped', 'Skipping LinkedIn question because answer is empty', {
            index: i,
            question: q.question,
            type: q.type,
            source,
            selectedAnswer: q.selectedAnswer,
            textAnswer: q.textAnswer,
            options: q.options || q.opts || []
          });
        }
        await driver.sleep(300);
      }
      printLog("--- End questions and answers ---");

      if (!fs.existsSync(jobDirPath)) {
        fs.mkdirSync(jobDirPath, { recursive: true });
      }
      fs.writeFileSync(
        path.join(jobDirPath, 'qna.json'),
        JSON.stringify({ questions: qnaResults }, null, 2)
      );
      printLog("Questions answered (intelligent flow)");
    } else {
      const modalCss = ctx.selectors?.easy_apply?.modal_container_css || "div.jobs-easy-apply-modal";
      const phone = ctx.config.formData?.phone || '';
      const email = ctx.config.formData?.email || '';
      let root: Awaited<ReturnType<WebDriver['findElement']>> = driver as any;
      try {
        root = await driver.findElement(By.css(modalCss));
      } catch {
        // no modal
      }
      const formElements = await root.findElements(By.css("div[data-test-form-element]"));
      for (const element of formElements) {
        try {
          const textInputs = await element.findElements(By.css('input[type="text"]'));
          for (const input of textInputs) {
            const label = (await input.getAttribute('aria-label')) || (await input.getAttribute('placeholder')) || '';
            const l = label.toLowerCase();
            if (phone && l.includes('phone')) {
              await input.clear();
              await input.sendKeys(phone);
            } else if (email && l.includes('email')) {
              await input.clear();
              await input.sendKeys(email);
            }
          }
          const selects = await element.findElements(By.css('select'));
          for (const select of selects) {
            try {
              const options = await select.findElements(By.css('option'));
              if (options.length > 1) await options[1].click();
            } catch {
              // ignore
            }
          }
          const radios = await element.findElements(By.css('input[type="radio"]'));
          if (radios.length > 0) {
            try {
              await radios[0].click();
            } catch {
              // ignore
            }
          }
        } catch {
          continue;
        }
      }
      printLog("Questions answered (basic flow)");
    }

    // Multi-stage: if primary button is Next/Continue/Review, click it and loop to extract next stage questions
    // Must scope to Easy Apply overlay only so we never match pagination "View next page" behind the modal
    let modalRoot: Awaited<ReturnType<WebDriver['findElement']>> | null = null;
    try {
      modalRoot = await driver.findElement(By.css("[data-test-modal-id='easy-apply-modal']"));
    } catch {
      try {
        modalRoot = await driver.findElement(By.css(ctx.selectors?.easy_apply?.modal_container_css || "div.jobs-easy-apply-modal"));
      } catch {
        // no modal
      }
    }
    if (!modalRoot) {
      yield "finished_answering_questions";
      return;
    }
    const nextXPathRel = ".//button[contains(., 'Next') or contains(., 'Continue') or contains(., 'Review')]";
    const submitXPathRel = ".//button[contains(., 'Submit application') or contains(., 'Submit')]";
    let primaryButton: Awaited<ReturnType<WebDriver['findElement']>> | null = null;
    let primaryText = '';
    try {
      const submitBtn = await modalRoot.findElement(By.xpath(submitXPathRel));
      if (submitBtn) {
        const isDisplayed = await submitBtn.isDisplayed();
        const isEnabled = await submitBtn.isEnabled();
        if (isDisplayed && isEnabled) {
          primaryButton = submitBtn;
          primaryText = (await submitBtn.getText())?.trim() || '';
        }
      }
    } catch {
      // submit not found
    }
    if (!primaryButton) {
      try {
        const nextBtn = await modalRoot.findElement(By.xpath(nextXPathRel));
        if (nextBtn) {
          const ariaLabel = (await nextBtn.getAttribute("aria-label")) || "";
          const className = (await nextBtn.getAttribute("class")) || "";
          const isPagination = ariaLabel.includes("View next page") || className.includes("jobs-search-pagination");
          if (!isPagination) {
            const isDisplayed = await nextBtn.isDisplayed();
            const isEnabled = await nextBtn.isEnabled();
            if (isDisplayed && isEnabled) {
              primaryButton = nextBtn;
              primaryText = (await nextBtn.getText())?.trim() || '';
            }
          }
        }
      } catch {
        // next not found
      }
    }
    const isSubmit = primaryText && (primaryText.includes('Submit') || primaryText.includes('Done'));
    if (primaryButton && !isSubmit) {
      await primaryButton.click();
      printLog(`Clicked "${primaryText}" – advancing to next stage`);
      await driver.sleep(2000);
      yield "next_stage";
      return;
    }
    yield "finished_answering_questions";
  } catch (error) {
    printLog(`Error answering questions: ${error}`);
    yield "error_answering_questions";
  }
}

// Submit application (Easy Apply modal – use easy_apply selectors, scope to modal)
export async function* submitApplication(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  printLog("Submitting application...");

  try {
    const driver = ctx.driver;
    const currentJob = ctx.current_job;
    const easyApply = ctx.selectors?.easy_apply;
    // Scope to Easy Apply overlay so we never click pagination "View next page" behind the modal
    const nextButtonXPathRel = ".//button[contains(., 'Next') or contains(., 'Continue')]";
    const submitButtonXPathRel = ".//button[contains(., 'Submit application') or contains(., 'Submit')]";

    let root: Awaited<ReturnType<WebDriver['findElement']>> | null = null;
    try {
      root = await driver.findElement(By.css("[data-test-modal-id='easy-apply-modal']"));
    } catch {
      try {
        root = await driver.findElement(By.css(easyApply?.modal_container_css || "div.jobs-easy-apply-modal"));
      } catch {
        // no modal
      }
    }

    const findNext = async () => {
      if (root) {
        try {
          return await root.findElement(By.xpath(nextButtonXPathRel));
        } catch {
          return null;
        }
      }
      return null;
    };
    const findSubmit = async () => {
      if (root) {
        try {
          return await root.findElement(By.xpath(submitButtonXPathRel));
        } catch {
          return null;
        }
      }
      return null;
    };

    let nextCount = 0;
    while (nextCount < 5) {
      const nextButton = await findNext();
      if (!nextButton) break;
      const buttonText = (await nextButton.getText())?.trim() || '';
      if (buttonText.includes('Submit') || buttonText.includes('Done')) break;
      await nextButton.click();
      printLog(`Clicked "${buttonText}" button (${nextCount + 1})`);
      await driver.sleep(2000);
      nextCount++;
    }

    const submitButton = await findSubmit();
    if (submitButton) {
      await submitButton.click();
      printLog("Application submitted");
      await driver.sleep(3000);

      ctx.applied_jobs = (ctx.applied_jobs || 0) + 1;

      if (ctx.overlay) {
        await ctx.overlay.updateJobProgress(
          ctx.applied_jobs,
          ctx.total_jobs || 0,
          `Applied: ${currentJob?.title || 'Job'}`,
          17
        ).catch(() => {});
      }

      yield "save_applied_job";
    } else {
      printLog("Submit button not found - modal may not have proper form");
      yield "application_failed";
    }
  } catch (error) {
    printLog(`Submit error: ${error}`);
    yield "application_failed";
  }
}

// Save applied job (persist applied ID and record to backend)
export async function* saveAppliedJob(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  printLog("Saving applied job...");

  try {
    const currentJob = ctx.current_job;
    const appliedJobIds = ctx.applied_job_ids || new Set();

    if (currentJob && currentJob.job_id) {
      appliedJobIds.add(currentJob.job_id);
      ctx.applied_job_ids = appliedJobIds;

      const jobIdsPath = path.join(process.cwd(), 'deknilJobsIds.json');
      fs.writeFileSync(jobIdsPath, JSON.stringify(Array.from(appliedJobIds), null, 2));

      const jobId = currentJob.job_id;
      const jobDirPath = getJobArtifactDir(ctx, 'linkedin', jobId);
      const jobFilePath = path.join(jobDirPath, 'job_details.json');
      if (fs.existsSync(jobFilePath)) {
        try {
          const result = await recordJobApplicationToBackend({
            jobFilePath,
            jobDirPath,
            platform: 'linkedin'
          });
          if (!result.ok) {
            printLog(`[JobRecorder] Backend record skipped: ${result.error}`);
          }
        } catch (recordErr) {
          printLog(`[JobRecorder] Record failed (continuing): ${recordErr}`);
        }
      }

      printLog(`Saved job ID: ${jobId}`);
      yield "job_saved";
    } else {
      yield "save_job_failed";
    }
  } catch (error) {
    printLog(`Error saving job: ${error}`);
    yield "save_job_failed";
  }
}

// External apply - Extract job details and save to JSON
export async function* externalApply(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const driver = ctx.driver;
    const currentJob = ctx.current_job;

    if (!currentJob) {
      yield "application_failed";
      return;
    }

    // Extract full job details from panel
    const jobDetails: any = {
      job_id: currentJob.job_id,
      title: currentJob.title,
      company: currentJob.company,
      location: currentJob.work_location || '',
      extracted_at: new Date().toISOString(),
      apply_type: 'external'
    };

    // Extract description
    try {
      const descElement = await driver.findElement(By.css('div.jobs-description__content'));
      jobDetails.description = (await descElement.getText()).trim();
    } catch (error) {
      jobDetails.description = '';
    }

    // Extract job URL
    try {
      const currentUrl = await driver.getCurrentUrl();
      jobDetails.url = currentUrl;
    } catch (error) {
      jobDetails.url = '';
    }

    // Save to JSON file
    const jobDirPath = getJobArtifactDir(ctx, 'linkedin', currentJob.job_id);
    const filepath = path.join(jobDirPath, 'job_details.json');
    fs.writeFileSync(filepath, JSON.stringify(jobDetails, null, 2));

    ctx.skipped_jobs = (ctx.skipped_jobs || 0) + 1;

    await ctx.overlay.updateJobProgress(
      ctx.applied_jobs || 0,
      ctx.total_jobs || 0,
      "External job saved",
      19
    );

    yield "save_external_job";
  } catch (error) {
    yield "application_failed";
  }
}

// Save external job
export async function* saveExternalJob(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  yield "external_job_saved";
}

// Application failed
export async function* applicationFailed(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  const currentJob = ctx.current_job;

  if (currentJob) {
    ctx.skipped_jobs = (ctx.skipped_jobs || 0) + 1;

    await ctx.overlay.updateJobProgress(
      ctx.applied_jobs || 0,
      ctx.total_jobs || 0,
      "Application failed",
      21
    );
  }

  yield "application_marked_failed";
}

// Continue processing
export async function* continueProcessing(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  const extractedJobs = ctx.extracted_jobs || [];
  const currentIndex = ctx.current_job_index || 0;

  if (currentIndex < extractedJobs.length - 1) {
    const nextIndex = currentIndex + 1;
    ctx.current_job_index = nextIndex;
    ctx.current_job = extractedJobs[nextIndex];

    yield "starting_next_application";
  } else {
    yield "navigate_to_next_page";
  }
}

// Navigate to next page
export async function* navigateToNextPage(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const driver = ctx.driver;
    const currentPage = ctx.pagination_current_page || 1;

    try {
      const nextPageButton = await driver.findElement(By.css(`button[aria-label="Page ${currentPage + 1}"]`));
      await nextPageButton.click();
      printLog(`Page ${currentPage + 1}`);
      await driver.sleep(3000);

      ctx.pagination_current_page = currentPage + 1;
      yield "extract_job_details";
    } catch (error) {
      yield "finish";
    }
  } catch (error) {
    yield "finish";
  }
}

// Finish
export async function* finish(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    const appliedCount = ctx.applied_jobs || 0;
    const skippedCount = ctx.skipped_jobs || 0;
    const totalCount = ctx.total_jobs || 0;

    printLog(`Workflow complete: Applied ${appliedCount}, Skipped ${skippedCount}, Total ${totalCount}`);

    if (ctx.overlay) {
      await ctx.overlay.updateJobProgress(
        appliedCount,
        totalCount,
        "Workflow completed!",
        24
      );
    }
  } catch (error) {
    printLog(`Finish error: ${error}`);
  }

  yield "done";
}

// Export step functions
export const linkedinStepFunctions = {
  step0,
  openCheckLogin,
  credentialLogin,
  showManualLoginPrompt,
  openJobsPage,
  setSearchLocation,
  setSearchKeywords,
  applyFilters,
  getPageInfo,
  extractJobDetails,
  processJobs,
  attemptEasyApply,
  extractJobDetailsFromPanel,
  uploadResume,
  handleCoverLetter,
  extractEmployerQuestions,
  answerQuestions,
  submitApplication,
  saveAppliedJob,
  externalApply,
  saveExternalJob,
  applicationFailed,
  continueProcessing,
  navigateToNextPage,
  finish
};
