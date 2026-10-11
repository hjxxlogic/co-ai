# Repository Guidelines

## Project Structure & Module Organization

This project runs on Cloudflare Workers using TypeScript, Hono, D1, and R2. `src/index.ts` assembles routes; other `src/` modules handle authentication, administration, items, roles, and shared types. `public/` contains the browser UI. `migrations/` holds numbered D1 SQL migrations, and `tests/api.test.ts` contains integration tests. Edit API documentation in `llm/`; `scripts/sync-assets.mjs` copies it into generated `public/llm/` assets.

## Build, Test, and Development Commands

Use Node.js 22.17+ and install dependencies with `npm ci`.

- Copy `.dev.vars.example` to `.dev.vars` and replace the placeholder `ADMIN_TOKEN` with a random secret.
- `npm run db:migrate:local`: apply migrations to local D1.
- `npm run dev`: start Wrangler with HTTPS at `https://localhost:8787`.
- `npm run typecheck`: check strict TypeScript without emitting files.
- `npm test`: run the Vitest suite.
- `npm run build`: validate Worker packaging with a dry run; output goes to `dist/`.

Development, build, and deployment automatically synchronize documentation assets.

## Coding Style & Naming Conventions

Follow existing two-space indentation, single-quoted JavaScript/TypeScript strings, and semicolons. Use camelCase for functions and variables, PascalCase for types, and existing snake_case API/database fields. Keep modules focused on their route or security responsibility. Validate request input with Zod and parameterize SQL. No dedicated formatter or lint script is configured; preserve surrounding style and run typechecking.

## Testing Guidelines

Use Vitest with Miniflare-backed local D1/R2 bindings. Name test files `tests/*.test.ts` and describe observable behavior in `it(...)` cases. Cover permission boundaries, validation, and relevant failure paths when changing endpoints. No numeric coverage threshold is configured. When adding migrations, update the explicit migration list in the test setup. Run typechecking, tests, and the build before submitting.

## Commit & Pull Request Guidelines

Recent commits use concise `feat: ...` subjects; follow that prefix style with an appropriate change type. PRs should explain the problem, resulting behavior, and validation performed. Link relevant issues and include screenshots for UI changes. Document migration or API changes and update `llm/` when contracts change.

## Security & Configuration

Never commit `.dev.vars` or log credentials. Preserve HTTPS enforcement, secure sessions, and user/project isolation. `wrangler.jsonc` targets production resources; remote migrations and deployment modify Cloudflare state and require deliberate execution against the intended account.
