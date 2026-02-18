# FinalBoss - Job Application Automation Platform

AI-powered job application automation platform that integrates with job boards (LinkedIn, Indeed, Seek) and generates personalized cover letters, resumes, and answers using the corpus-rag API.

---

## 🌿 Git Branches

**Branch Strategy:**
- **`develop`** - Development branch (for active development and testing)
- **`alpha`** - Production branch (stable, deployed to production)

**Usage:**
- For development work, use: `git checkout develop`
- For production deployment, use: `git checkout alpha`
- Always merge `develop` → `alpha` when ready for production

---

## 🚀 Quick Start

> **📌 Branch Information:** This project uses `develop` for development and `alpha` for production. See [Git Branches](#-git-branches) section for details.

### Prerequisites
- Node.js (v18 or higher)
- **bun** (recommended) or npm — this project uses bun per monorepo conventions
- MongoDB is required only for the **corpus-rag** API (run corpus-rag separately for AI features)
- Chrome/Chromium browser (for bot automation)

### Installation

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd finalboss
   ```

2. **Checkout the appropriate branch:**
   ```bash
   git checkout develop  # For development
   # or
   git checkout alpha    # For production
   ```

3. **Install dependencies:**
   ```bash
   bun install
   # or
   npm install
   ```

4. **Configure environment variables:**
   Create a `.env` or `.env.local` file in the project root:
   ```bash
   # Corpus-rag API (default if not set)
   PUBLIC_API_BASE=http://localhost:3000
   VITE_API_BASE=http://localhost:3000
   ```

5. **Start the development server:**
   ```bash
   bun run dev
   # or
   npm run dev
   # Without env loading:
   bun run dev:plain
   ```

6. **Access the application:**
   - Web: `http://localhost:1420` (Vite is configured for port 1420 for Tauri)
   - Tauri Desktop App: `bun run tauri:dev` or `npm run tauri:dev`

---

## 📋 Overview

FinalBoss is a comprehensive job application automation platform with the following features:

### Core Features
- **Job Board Integration**: Automated job searching and application on LinkedIn, Indeed, and Seek
- **AI-Powered Content Generation** (via corpus-rag API):
  - Personalized cover letters
  - Tailored resume enhancement
  - Intelligent employer Q&A
- **Resume Builder**: Create and manage resumes used by bots and AI
- **Token plans & billing**: Stripe checkout, token balance, order history (via corpus-rag)
- **API Testing Interface**: Built-in API testing at `/api-test` for corpus-rag integration
- **Desktop Application**: Tauri 2–based desktop app for cross-platform support

### Components

1. **Web Interface** (SvelteKit 2, Svelte 5, static adapter)
   - App shell, login, token/plans/orders/payment flows
   - Bot selection and configuration (choose-bot, control-bar)
   - API testing interface (`/api-test`)
   - Cover letter, resume enhancement, resume builder, job analytics, generic questions

2. **Bot Automation System** (`src/bots/`)
   - **core/**: Workflow engine (YAML steps), browser manager (Selenium/Playwright), humanization, session manager, universal overlay
   - **seek/**, **linkedin/**, **indeed/**: Per-platform impls with `*_impl.ts`, `*_steps.yaml`, and `config/*_selectors.json`
   - Entry: `bot_starter.ts`; shared config: `user-bots-config.json`

3. **API Integration**
   - `corpus-rag-client.js`, `corpus-rag-auth.js`, `api-config.js`
   - JWT refresh and token persistence (e.g. `.cache/jwt_tokens.json`)
   - Job application handling and proxy routes under `src/routes/api/`

---

## 🛠️ Development

### Available Scripts

Use **bun** (recommended) or npm:

```bash
# Development
bun run dev              # Start dev server (port 1420, loads .env)
bun run dev:plain        # Start dev server without env loading

# Building
bun run build            # Vite production build (static SPA)
bun run preview          # Preview production build

# Tauri (Desktop App)
bun run tauri            # Tauri CLI (e.g. tauri build)
bun run tauri:dev        # Tauri dev mode with env

# Testing (Vitest)
bun run test             # Watch mode
bun run test:run         # Single run

# Type Checking
bun run check            # svelte-check
bun run check:watch      # svelte-check watch
```

### Project Structure

```
finalboss/
├── src/
│   ├── routes/              # SvelteKit routes (static adapter)
│   │   ├── api/             # Client-side API proxies to corpus-rag
│   │   ├── api-test/        # API testing UI
│   │   ├── app/, login/, choose-bot/, control-bar/
│   │   ├── cover-letters/, resume-enhancement/, resume-builder/
│   │   ├── job-analytics/, generic-questions/, tokens/, plans/, payment/, orders/
│   │   └── ...
│   ├── bots/                # Bot automation
│   │   ├── core/            # Workflow engine, browser manager, humanization, overlay
│   │   ├── bot_starter.ts   # Entry point
│   │   ├── user-bots-config.json
│   │   ├── seek/            # *_impl.ts, *_steps.yaml, config/*_selectors.json
│   │   ├── linkedin/
│   │   └── indeed/
│   ├── lib/                 # Shared code
│   │   ├── corpus-rag-client.js, corpus-rag-auth.js, api-config.js
│   │   ├── job-application-handler.js, authService.js
│   │   └── ...
│   └── ...
├── src-tauri/               # Tauri 2 desktop shell
├── static/
└── package.json
```

---

## 🔗 Integration with Corpus-Rag API

FinalBoss integrates with the corpus-rag API for AI-powered content generation. Ensure the corpus-rag API is running and accessible.

### Authentication Flow

1. User logs in through finalboss (or service account via client_id/secret).
2. Session is converted to JWT via corpus-rag (`/api/auth/session-to-jwt`).
3. JWT (and refresh token) are stored and persisted (e.g. `.cache/jwt_tokens.json`) for reuse across runs.
4. corpus-rag-client uses the JWT for all API requests and refreshes on 401.

### API Endpoints Used (corpus-rag)

- `/api/auth/session-to-jwt`, `/api/auth/token`, `/api/auth/refresh` — Auth and JWT
- `/api/cover_letter`, `/api/resume`, `/api/questionAndAnswers` — AI generation
- `/api/jobs`, `/api/upload` — Job listings and file uploads
- `/api/tokens/`, `/api/plans/`, `/api/orders/` — Billing and tokens

---

## 🧪 Testing

### API Testing

The application includes a built-in API testing interface at `/api-test` that allows you to:
- Test cover letter generation
- Test resume enhancement
- Test question answering
- View authentication status
- Debug API responses

### Running Tests

```bash
bun run test          # Watch mode
bun run test:run      # Single run
```

---

## 📦 Building for Production

### Web Build

```bash
bun run build
bun run preview   # Test production build locally
```

### Tauri Desktop Build

```bash
bun run tauri build
```

---

## 🔧 Configuration

### Environment Variables

- `PUBLIC_API_BASE` — Base URL for corpus-rag API (e.g. `http://localhost:3000`)
- `VITE_API_BASE` — Same, used by Vite-backed code

Loaded from `.env` or `.env.local` when using `bun run dev` / `bun run tauri:dev`.

### Bot Configuration

- `src/bots/user-bots-config.json` — Shared keywords, locations, resume path
- `src/bots/{seek,linkedin,indeed}/*_steps.yaml` — Workflow steps and transitions
- `src/bots/{seek,linkedin,indeed}/config/*_selectors.json` — DOM selectors
- See `src/bots/BOT_STANDARDS.md` for the full bot contract

---

## 🐛 Troubleshooting

### Common Issues

1. **API Connection Errors**
   - Ensure corpus-rag API is running
   - Check `PUBLIC_API_BASE` environment variable
   - Verify network connectivity

2. **Authentication Issues**
   - Clear localStorage and sessionStorage; optionally remove `.cache/jwt_tokens.json` and `.cache/api_token.txt`
   - Re-login to get fresh tokens
   - Check token expiration and corpus-rag JWT settings

3. **Bot Automation Failures**
   - Ensure Chrome/Chromium is installed
   - Check browser driver compatibility
   - Verify selectors in bot configuration files

---

## 📝 Contributing

1. **Checkout the development branch:**
   ```bash
   git checkout develop
   git pull origin develop
   ```

2. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make your changes and test thoroughly**

4. **Commit and push:**
   ```bash
   git add .
   git commit -m "Description of changes"
   git push origin feature/your-feature-name
   ```

5. **Create a pull request to `develop`**

6. **After review and testing, merge to `alpha` for production**

---

## 📄 License

MIT

---

## 🤝 Support

For issues, feature requests, or questions, please open an issue on GitHub.

---

## 🔄 Deployment

### Development Deployment
- Deploy from `develop` branch
- Use for staging/testing environments

### Production Deployment
- Deploy from `alpha` branch
- Ensure all tests pass
- Review changelog before deployment

```bash
# Before production deployment
git checkout alpha
git pull origin alpha
bun run build
bun run test:run
```
