<script>
  import { onMount } from 'svelte';
  import { authService } from '$lib/authService.js';
  import { CorpusRagAuth } from '$lib/corpus-rag-auth.js';
  import { page } from '$app/stores';
  import TokenBalance from '$lib/components/TokenBalance.svelte';
  import '../app.css';

  // Always show clean login page, regardless of auth state
  $: isLoginPage = $page.url.pathname === '/login';

  let sessionValidationMessage = '';
  let showSessionNotification = false;

  onMount(async () => {
    await authService.initialize();

    // Validate session with corpus-rag server on startup
    if ($authService.isLoggedIn) {
      try {
        const validation = await CorpusRagAuth.validateSession();

        if (!validation.valid) {
          // Session expired or invalid - show notification but don't log out
          sessionValidationMessage = 'Could not reach the server to verify your session. Some features may be unavailable.';
          showSessionNotification = true;

          // Auto-hide notification after 10 seconds
          setTimeout(() => {
            showSessionNotification = false;
          }, 10000);
        }
      } catch (error) {
        console.error('Session validation failed:', error);
        // Don't show error to user if it's just a network issue
      }
    }
  });

  function dismissNotification() {
    showSessionNotification = false;
  }
</script>

{#if $authService.loading}
  <!-- Loading State -->
  <div class="min-h-screen flex items-center justify-center bg-base-200">
    <div class="text-center">
      <span class="loading loading-spinner loading-lg text-primary"></span>
      <p class="mt-4 text-base-content/70">Loading...</p>
    </div>
  </div>
{:else if !isLoginPage && $authService.isLoggedIn && $authService.user}
  <!-- Session Validation Notification -->
  {#if showSessionNotification}
    <div class="toast toast-top toast-end z-50">
      <div class="alert alert-warning shadow-lg max-w-md">
        <div>
          <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current flex-shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <h3 class="font-bold">Connection Warning</h3>
            <div class="text-xs">{sessionValidationMessage}</div>
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" on:click={dismissNotification}>✕</button>
      </div>
    </div>
  {/if}

  <!-- Authenticated Layout with DaisyUI Drawer -->
  <div class="drawer lg:drawer-open">
    <input id="drawer-toggle" type="checkbox" class="drawer-toggle" />

    <!-- Drawer Content (Main) -->
    <div class="drawer-content flex flex-col">
      <!-- Mobile Navbar -->
      <div class="navbar bg-base-100 lg:hidden">
        <div class="flex-none">
          <label for="drawer-toggle" class="btn btn-square btn-ghost">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
            </svg>
          </label>
        </div>
        <div class="flex-1">
          <a class="btn btn-ghost text-xl" href="/app">Quest Bot</a>
        </div>
        <div class="flex-none">
          <div class="dropdown dropdown-end">
            <div tabindex="0" role="button" class="btn btn-ghost btn-circle avatar">
              <div class="w-10 rounded-full bg-primary text-primary-content flex items-center justify-center">
                {($authService.user.name || $authService.user.email).charAt(0).toUpperCase()}
              </div>
            </div>
            <ul tabindex="-1" class="menu menu-sm dropdown-content mt-3 z-[1] p-2 shadow bg-base-100 rounded-box w-52">
              <li><a href="/profile">Profile</a></li>
              <li><button on:click={() => authService.logout()}>Logout</button></li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Main Content -->
      <main class="flex-1 p-6">
        <slot></slot>
      </main>
    </div>

    <!-- Drawer Side -->
    <div class="drawer-side">
      <label for="drawer-toggle" aria-label="close sidebar" class="drawer-overlay"></label>
      <aside class="min-h-full w-80 bg-base-200">
        <!-- Sidebar Header -->
        <div class="p-4 border-b border-base-300">
          <a href="/app" class="text-2xl font-bold text-primary">
            Quest Bot
          </a>
        </div>

        <!-- Navigation Menu -->
        <ul class="menu p-4 space-y-2 w-full">
          <li>
            <a href="/app" class="{$page.url.pathname === '/app' ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path>
              </svg>
              Dashboard
            </a>
          </li>
          <li>
            <a href="/choose-bot" class="{$page.url.pathname === '/choose-bot' ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
              </svg>
              Choose Bot
            </a>
          </li>
          <li>
            <a href="/cover-letters" class="{$page.url.pathname === '/cover-letters' ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
              </svg>
              Cover Letters
            </a>
          </li>
          <li>
            <a href="/resume-enhancement" class="{$page.url.pathname === '/resume-enhancement' ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
              </svg>
              Resume Enhancement
            </a>
          </li>
          <li>
            <a href="/resume-builder" class="{$page.url.pathname.startsWith('/resume-builder') ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
              </svg>
              Resume Builder
            </a>
          </li>
          <li>
            <a href="/frontend-form" class="{$page.url.pathname === '/frontend-form' ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
              </svg>
              Configuration
            </a>
          </li>
          <li>
            <a href="/backend-analytics" class="{$page.url.pathname === '/backend-analytics' ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
              </svg>
              Analytics
            </a>
          </li>
          <li>
            <a href="/job-analytics" class="{$page.url.pathname.startsWith('/job-analytics') ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
              </svg>
              Job Analytics
            </a>
          </li>
          <li>
            <a href="/testfunctions" class="{$page.url.pathname === '/testfunctions' ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"></path>
              </svg>
              Test Functions
            </a>
          </li>
          <li>
            <a href="/generic-questions" class="{$page.url.pathname === '/generic-questions' ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
              Generic Questions
            </a>
          </li>
          <li>
            <a href="/api-test" class="{$page.url.pathname === '/api-test' ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path>
              </svg>
              API Test
            </a>
          </li>
          <li>
            <a href="/plans" class="{$page.url.pathname === '/plans' ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
              Buy Tokens
            </a>
          </li>
          <li>
            <a href="/orders" class="{$page.url.pathname.startsWith('/orders') ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path>
              </svg>
              Orders
            </a>
          </li>
          <li>
            <a href="/tokens/history" class="{$page.url.pathname.startsWith('/tokens') ? 'active' : ''}">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path>
              </svg>
              Token History
            </a>
          </li>
        </ul>

        <!-- Token Balance Section -->
        <div class="p-4 border-t border-base-300">
          <div class="card bg-base-100 shadow-sm">
            <div class="card-body p-4">
              <div class="flex items-center justify-between mb-2">
                <span class="text-sm font-semibold">Token Balance</span>
                <a href="/plans" class="text-xs link link-primary">Buy More</a>
              </div>
              <div class="flex items-center gap-2">
                <TokenBalance compact={true} showLabel={false} />
              </div>
            </div>
          </div>
        </div>

        <!-- User Section -->
        <div class="p-4 border-t border-base-300">
          <div class="flex items-center gap-3 mb-3">
            <div class="avatar">
              <div class="w-10 rounded-full bg-primary text-primary-content flex items-center justify-center">
                {($authService.user.name || $authService.user.email).charAt(0).toUpperCase()}
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="font-semibold text-sm truncate">
                {$authService.user.name || $authService.user.email.split('@')[0]}
              </div>
              <div class="text-xs text-base-content/70 truncate">
                {$authService.user.email}
              </div>
            </div>
          </div>
          <button class="btn btn-outline btn-sm w-full" on:click={() => authService.logout()}>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path>
            </svg>
            Logout
          </button>
        </div>
      </aside>
    </div>
  </div>
{:else}
  <!-- Non-authenticated Layout OR Login Page -->
  {#if isLoginPage}
    <!-- Login page: completely clean, no navbar or wrapper -->
    <slot></slot>
  {:else}
    <!-- Other non-authenticated pages: show navbar -->
    <div class="navbar bg-base-100">
      <div class="flex-1">
        <a class="btn btn-ghost text-xl" href="/login">Quest Bot</a>
      </div>
      <div class="flex-none">
        <a class="btn btn-primary" href="/login">Login</a>
      </div>
    </div>

    <main class="min-h-screen bg-base-200">
      <slot></slot>
    </main>
  {/if}
{/if}