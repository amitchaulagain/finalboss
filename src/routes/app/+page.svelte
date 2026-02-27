<script>
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { authService } from '$lib/authService.js';

  // Check authentication on mount
  onMount(() => {
    if (!$authService.isLoggedIn) {
      goto('/login');
    }
  });

  $: user = $authService.user;
  let showWelcome = true;

  function navigateTo(path) {
    goto(path);
  }

  function closeWelcome() {
    showWelcome = false;
  }
</script>

<main class="container mx-auto p-6">
  {#if user}
    <!-- Welcome Hero Section -->
    {#if showWelcome}
      <div class="alert bg-base-100 shadow-xl mb-8 relative">
        <div class="flex-1">
          <div>
            <h1 class="text-3xl font-bold mb-2">Welcome Back!</h1>
            <p class="text-base-content/70">
              Hello {user.name || user.email.split('@')[0]}, ready to supercharge your job search?
            </p>
          </div>
        </div>
        <button
          class="btn btn-ghost btn-sm btn-circle absolute top-2 right-2"
          on:click={closeWelcome}
          aria-label="Close welcome message"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    {/if}

    <!-- Dashboard Cards -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <!-- Choose Bot Card -->
      <div class="card bg-base-100 shadow-xl hover:shadow-2xl transition-all duration-300 cursor-pointer"
           on:click={() => navigateTo('/choose-bot')}
           on:keydown={(e) => e.key === 'Enter' && navigateTo('/choose-bot')}
           role="button"
           tabindex="0">
        <figure class="px-10 pt-10">
          <div class="text-6xl">🤖</div>
        </figure>
        <div class="card-body items-center text-center">
          <h2 class="card-title">Choose Bot</h2>
          <p>Select and configure your automation bot for job searching across different platforms</p>
          <div class="card-actions">
            <div class="badge badge-primary">Automation</div>
            <div class="badge badge-outline">Essential</div>
          </div>
        </div>
      </div>

      <!-- Configuration Card -->
      <div class="card bg-base-100 shadow-xl hover:shadow-2xl transition-all duration-300 cursor-pointer"
           on:click={() => navigateTo('/frontend-form')}
           on:keydown={(e) => e.key === 'Enter' && navigateTo('/frontend-form')}
           role="button"
           tabindex="0">
        <figure class="px-10 pt-10">
          <div class="text-6xl">⚙️</div>
        </figure>
        <div class="card-body items-center text-center">
          <h2 class="card-title">Configuration</h2>
          <p>Set up your preferences, filters, and automation settings for optimal job searching</p>
          <div class="card-actions">
            <div class="badge badge-secondary">Settings</div>
            <div class="badge badge-outline">Customize</div>
          </div>
        </div>
      </div>

      <!-- Quick Stats Card -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path>
            </svg>
            Quick Stats
          </h2>
          <div class="stats stats-vertical shadow">
            <div class="stat">
              <div class="stat-title">Applications</div>
              <div class="stat-value text-primary">0</div>
              <div class="stat-desc">Today</div>
            </div>

            <div class="stat">
              <div class="stat-title">Success Rate</div>
              <div class="stat-value text-secondary">0%</div>
              <div class="stat-desc">All time</div>
            </div>
          </div>
          <div class="card-actions justify-end">
          </div>
        </div>
      </div>

    </div>
  {:else}
    <!-- Not Authenticated -->
    <div class="hero min-h-[50vh] bg-base-200">
      <div class="hero-content text-center">
        <div class="max-w-md">
          <h1 class="text-5xl font-bold">Access Restricted</h1>
          <p class="py-6">Please log in to access the Quest Bot dashboard and start automating your job search.</p>
          <a href="/login" class="btn btn-primary">Go to Login</a>
        </div>
      </div>
    </div>
  {/if}
</main>