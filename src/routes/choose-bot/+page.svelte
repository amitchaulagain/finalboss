<script>
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import BotStats from '$lib/components/BotStats.svelte';

  // Dynamic bot list
  let bots = [
    {
      name: 'seek_bot',
      description: 'Automate job searching on Seek.com.au with advanced filtering and application features',
      image: '/seek-logo.png'
    },
    {
      name: 'linkedin_bot',
      description: 'Automate job searching on LinkedIn with Easy Apply and smart filtering',
      image: '/linkedin-logo.png'
    },
    {
      name: 'indeed_bot',
      description: 'Automate job searching on Indeed with Camoufox stealth browser and smart application features',
      image: '/indeed-logo.png'
    }
  ];

  let unlistenProgress = null;

  // Load available bots on mount
  onMount(async () => {
    try {
      // Try to get bots dynamically - if this fails, keep the static list
      const availableBots = await invoke('get_available_bots');
      if (availableBots && availableBots.length > 0) {
        bots = availableBots.map(botName => ({
          name: `${botName}_bot`,
          description: `Automate job searching on ${botName}`,
          image: `/${botName}-logo.png`
        }));
      }
    } catch (error) {
      console.log('Using static bot list (dynamic discovery not available)');
      // Keep the static bot list as fallback
    }

    // Listen for bot progress events from Rust
    unlistenProgress = await listen('bot-progress', (event) => {
      handleBotProgressEvent(event.payload);
    });
  });

  onDestroy(() => {
    if (unlistenProgress) {
      unlistenProgress();
    }
  });

  // Running bots tracking - supports multiple concurrent bots
  let runningBots = [];

  // Config validation state
  let showConfigError = false;

  function handleBotProgressEvent(event) {
    console.log('Bot progress event:', event);

    // Find bot by botId (from data) or use the first running bot if only one
    let bot = runningBots.find(b => b.botId === event.data?.botId);

    // If no bot found by ID, and we have exactly one bot running, assume it's for that bot
    if (!bot && runningBots.length === 1) {
      bot = runningBots[0];
    }

    // Create new bot on initialization event
    if (!bot && event.type === 'info' && event.message?.includes('initialized')) {
      bot = {
        name: 'seek_bot',
        botId: event.data?.botId || `bot_${Date.now()}`, // Fallback ID
        currentStep: 'Initializing...',
        totalJobs: 0,
        jobsProcessed: 0,
        appliedJobs: 0,
        skippedJobs: 0,
        isExpanded: true,
        consoleMessages: [] // Track all console messages
      };
      runningBots = [...runningBots, bot];
    }

    if (!bot) {
      console.warn('Could not find bot for event:', event);
      return;
    }

    // Initialize consoleMessages if not present (for existing bots)
    if (!bot.consoleMessages) {
      bot.consoleMessages = [];
    }

    // Update bot stats based on event type
    switch (event.type) {
      case 'step_start':
        // Format: "Step 5: performBasicSearch"
        const stepName = event.funcName?.replace(/([A-Z])/g, ' $1').trim(); // camelCase to Title Case
        bot.currentStep = `Step ${event.stepNumber}: ${stepName || event.funcName}`;
        bot.consoleMessages.push({ type: 'step', text: bot.currentStep, timestamp: new Date() });
        break;

      case 'transition':
        // Format: "openHomepage → homepage_opened"
        const transitionMsg = event.transition?.replace(/_/g, ' '); // snake_case to readable
        bot.currentStep = `✓ ${transitionMsg || event.transition}`;
        bot.consoleMessages.push({ type: 'transition', text: bot.currentStep, timestamp: new Date() });
        break;

      case 'info':
        if (event.message?.includes('completed')) {
          bot.currentStep = '✅ Workflow completed successfully!';
          bot.consoleMessages.push({ type: 'success', text: bot.currentStep, timestamp: new Date() });
          // Remove from running list after delay
          setTimeout(() => {
            runningBots = runningBots.filter(b => b.botId !== bot.botId);
          }, 5000);
        } else if (event.message) {
          bot.currentStep = event.message;
          bot.consoleMessages.push({ type: 'info', text: event.message, timestamp: new Date() });
        }
        break;

      case 'job_stat':
        if (event.data) {
          bot.totalJobs = event.data.totalJobs || bot.totalJobs;
          bot.jobsProcessed = event.data.jobsProcessed || bot.jobsProcessed;
          bot.appliedJobs = event.data.appliedJobs || bot.appliedJobs;
          bot.skippedJobs = event.data.skippedJobs || bot.skippedJobs;
        }
        break;

      case 'error':
        bot.currentStep = `❌ Error: ${event.message}`;
        bot.consoleMessages.push({ type: 'error', text: bot.currentStep, timestamp: new Date() });
        break;

      default:
        console.log('Unhandled event type:', event.type);
    }

    runningBots = [...runningBots]; // Trigger reactivity
  }

  function handleBotClick(botName) {
    // Check if this bot is already running
    const alreadyRunning = runningBots.some(bot => bot.name === botName);
    if (alreadyRunning) return; // Prevent multiple instances of same bot

    // Directly run the bot - no browser selection needed
    runBot(botName);
  }

  function isBotRunning(botName) {
    return runningBots.some(bot => bot.name === botName);
  }

  function stopBot(botId) {
    console.log(`Stopping bot ${botId}...`);
    // TODO: Implement actual bot stop functionality via Rust
    // For now, just remove from running list
    runningBots = runningBots.filter(bot => bot.botId !== botId);
  }

  async function runBot(botName) {
    try {
      // CHECK: Does config file exist by trying to read it
      try {
        await invoke('read_file_async', {
          filename: 'src/bots/user-bots-config.json'
        });
      } catch (readError) {
        // File doesn't exist or can't be read
        showConfigError = true;
        return;
      }

      console.log(`Starting ${botName} with streaming...`);

      // Convert bot names: seek_bot -> seek
      const cleanBotName = botName.replace('_bot', '');

      // Start bot with streaming support
      const result = await invoke('run_bot_streaming', {
        botName: cleanBotName
      });

      console.log(`Bot started:`, result);

      // Progress updates will come via 'bot-progress' events
      // which are handled by handleBotProgressEvent

    } catch (error) {
      console.error(`Error starting ${botName}:`, error);

      // Show error in UI
      alert(`Failed to start bot: ${error}`);
    }
  }

  // Function to navigate to config page
  function goToConfig() {
    showConfigError = false;
    goto('/frontend-form');
  }

</script>


<div class="container mx-auto p-8">
  <h1 class="text-4xl font-bold text-center mb-8">Choose a Bot</h1>

  <!-- Bot Selection Cards -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
    {#each bots as bot}
      <div
        class="card bg-base-100 shadow-xl hover:shadow-2xl transition-all duration-300"
        class:opacity-50={isBotRunning(bot.name)}
        class:cursor-not-allowed={isBotRunning(bot.name)}
        class:cursor-pointer={!isBotRunning(bot.name)}
      >
        <figure class="px-10 pt-10">
          <div class="avatar">
            <div class="w-24 rounded-full ring ring-primary ring-offset-base-100 ring-offset-2">
              <img src={bot.image} alt={bot.name} />
            </div>
          </div>
        </figure>
        <div class="card-body items-center text-center">
          <h2 class="card-title text-primary text-lg">{bot.name}</h2>
          <p class="text-sm">{bot.description}</p>

          <div class="card-actions w-full mt-4">
            {#if isBotRunning(bot.name)}
              <button
                class="btn btn-error btn-sm w-full"
                on:click={() => stopBot(bot.name)}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
                Stop Bot
              </button>
            {:else}
              <button
                class="btn btn-primary btn-sm w-full"
                on:click={() => handleBotClick(bot.name)}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Start Bot
              </button>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>

  <!-- Running Bots Stats Section -->
  {#if runningBots.length > 0}
    <div class="divider text-lg font-semibold">Running Bots</div>

    <div class="space-y-4">
      {#each runningBots as botStat}
        <BotStats
          botName={botStat.name}
          currentStep={botStat.currentStep}
          totalJobs={botStat.totalJobs}
          jobsProcessed={botStat.jobsProcessed}
          appliedJobs={botStat.appliedJobs}
          skippedJobs={botStat.skippedJobs}
          isExpanded={botStat.isExpanded}
          consoleMessages={botStat.consoleMessages || []}
          onStop={() => stopBot(botStat.botId)}
        />
      {/each}
    </div>
  {/if}
</div>

<!-- Config Missing Error Modal -->
{#if showConfigError}
  <div class="modal modal-open">
    <div class="modal-box bg-error text-error-content">
      <h3 class="font-bold text-lg mb-4">⚠️ Configuration Required</h3>
      <p class="mb-4">
        You need to create your bot configuration before running any bots.
      </p>
      <p class="mb-6">
        Please go to the <strong>Configuration</strong> page and set up your:
      </p>
      <ul class="list-disc list-inside mb-6 space-y-1">
        <li>Job search keywords (e.g., "Java developer", "Data Analyst")</li>
        <li>Preferred location (e.g., "Sydney", "Remote")</li>
        <li>Other preferences (optional)</li>
      </ul>
      <div class="modal-action">
        <button class="btn btn-primary" on:click={goToConfig}>
          Go to Configuration Page
        </button>
        <button class="btn btn-ghost" on:click={() => showConfigError = false}>
          Cancel
        </button>
      </div>
    </div>
    <div class="modal-backdrop" on:click={() => showConfigError = false}></div>
  </div>
{/if}