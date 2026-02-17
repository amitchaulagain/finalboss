<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { authService } from '$lib/authService.js';

  let mode = 'login'; // 'login' or 'signup'
  let email = '';
  let password = '';
  let name = '';
  let error = '';
  let loading = false;
  let success = '';
  let rememberMe = true; // Default to true for convenience
  let showPassword = false;

  // Clear any existing auth state when landing on login page
  onMount(() => {
    if ($authService.isLoggedIn) {
      // Already logged in, redirect to app
      goto('/app');
    }
    // Load saved email if exists
    const savedEmail = localStorage.getItem('savedEmail');
    if (savedEmail) {
      email = savedEmail;
      rememberMe = true;
    }
  });

  function switchMode() {
    mode = mode === 'login' ? 'signup' : 'login';
    error = '';
    success = '';
    password = '';
  }

  function togglePasswordVisibility() {
    showPassword = !showPassword;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    error = '';
    success = '';

    if (!email || !email.includes('@')) {
      error = 'Please enter a valid email address';
      return;
    }

    if (!password || password.length < 8) {
      error = 'Password must be at least 8 characters';
      return;
    }

    loading = true;

    // Save or clear email based on remember me
    if (rememberMe) {
      localStorage.setItem('savedEmail', email);
      localStorage.setItem('rememberMe', 'true');
    } else {
      localStorage.removeItem('savedEmail');
      localStorage.removeItem('rememberMe');
    }

    let result;
    if (mode === 'signup') {
      result = await authService.signup(email, password, name || email.split('@')[0], rememberMe);
    } else {
      result = await authService.login(email, password, rememberMe);
    }

    if (!result.success) {
      error = result.error || `${mode === 'signup' ? 'Signup' : 'Login'} failed. Please try again.`;
      loading = false;
    } else {
      // Success! Show feedback and redirect
      success = mode === 'signup' ? 'Account created successfully!' : 'Login successful!';
      // Small delay to show success message, then redirect
      setTimeout(() => {
        goto('/app');
      }, 500);
    }
  }
</script>

<svelte:head>
  <title>{mode === 'signup' ? 'Sign Up' : 'Login'} - Finalboss Job Application Assistant</title>
</svelte:head>

<main class="min-h-screen bg-base-200 flex items-center justify-center p-4">
  <div class="max-w-md w-full">
    <!-- Header -->
    <div class="text-center mb-8">
      <h1 class="text-4xl font-bold text-primary mb-2">Finalboss</h1>
      <p class="text-base-content/70">AI-Powered Job Application Assistant</p>
    </div>

    <!-- Auth Card -->
    <div class="card bg-base-100 shadow-xl">
      <div class="card-body">
        <!-- Tabs -->
        <div role="tablist" class="tabs tabs-boxed mb-6">
          <button
            role="tab"
            class="tab"
            class:tab-active={mode === 'login'}
            on:click={() => { mode = 'login'; error = ''; }}
          >
            Login
          </button>
          <button
            role="tab"
            class="tab"
            class:tab-active={mode === 'signup'}
            on:click={() => { mode = 'signup'; error = ''; }}
          >
            Sign Up
          </button>
        </div>

        {#if error}
          <div class="alert alert-error mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{error}</span>
          </div>
        {/if}

        {#if success}
          <div class="alert alert-success mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{success} Redirecting...</span>
          </div>
        {/if}

        <!-- Auth Form -->
        <form on:submit={handleSubmit} class="space-y-4">
          {#if mode === 'signup'}
            <div class="form-control">
              <label class="label" for="name">
                <span class="label-text">Name (optional)</span>
              </label>
              <input
                id="name"
                type="text"
                placeholder="Your Name"
                class="input input-bordered w-full"
                bind:value={name}
                disabled={loading}
              />
            </div>
          {/if}

          <div class="form-control">
            <label class="label" for="email">
              <span class="label-text">Email Address</span>
            </label>
            <input
              id="email"
              type="email"
              placeholder="your.email@example.com"
              class="input input-bordered w-full"
              bind:value={email}
              disabled={loading}
              required
            />
          </div>

          <div class="form-control">
            <label class="label" for="password">
              <span class="label-text">Password</span>
            </label>
            <div class="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="Min. 8 characters"
                class="input input-bordered w-full pr-12"
                bind:value={password}
                disabled={loading}
                required
                minlength="8"
              />
              <button
                type="button"
                class="btn btn-ghost btn-sm btn-circle absolute right-2 top-1/2 -translate-y-1/2"
                on:click={togglePasswordVisibility}
                disabled={loading}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {#if showPassword}
                  <!-- Eye Slash Icon -->
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                {:else}
                  <!-- Eye Icon -->
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                {/if}
              </button>
            </div>
          </div>

          {#if mode === 'login'}
            <div class="form-control">
              <label class="label cursor-pointer justify-start gap-2">
                <input
                  type="checkbox"
                  class="checkbox checkbox-primary checkbox-sm"
                  bind:checked={rememberMe}
                  disabled={loading}
                />
                <span class="label-text">Remember me</span>
              </label>
              <div class="label">
                <span class="label-text-alt text-base-content/60">
                  {rememberMe ? 'Stay logged in until you log out' : 'Session will end when you close the app'}
                </span>
              </div>
            </div>
          {/if}

          <button
            type="submit"
            class="btn btn-primary w-full"
            disabled={loading}
          >
            {#if loading}
              <span class="loading loading-spinner loading-sm"></span>
              {mode === 'signup' ? 'Creating account...' : 'Signing in...'}
            {:else}
              {mode === 'signup' ? 'Create Account' : 'Sign In'}
            {/if}
          </button>
        </form>

        <!-- Switch mode link -->
        <div class="text-center mt-4">
          <p class="text-sm text-base-content/70">
            {mode === 'login' ? "Don't have an account?" : "Already have an account?"}
            <button
              type="button"
              class="link link-primary"
              on:click={switchMode}
              disabled={loading}
            >
              {mode === 'login' ? 'Sign up' : 'Login'}
            </button>
          </p>
        </div>

        <!-- Info Box -->
        <div class="bg-base-200 rounded-lg p-4 text-sm mt-4">
          <div class="flex items-start gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-info flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p class="font-semibold mb-1">Secure Authentication</p>
              <p class="text-base-content/70">
                {mode === 'signup'
                  ? 'Create an account with your email and password. Your password is securely encrypted.'
                  : 'Sign in with your email and password to access your job applications.'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="text-center mt-8 text-sm text-base-content/60">
      <p>Your streamlined job application journey starts here.</p>
    </div>
  </div>
</main>

