import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('builds complete HTML docs with crawlable links, escaped code and retained source documents', async () => {
  await promisify(execFile)(process.execPath, ['scripts/sync-assets.mjs']);
  const guide = await readFile(new URL('../public/llm/index.html', import.meta.url), 'utf8');
  const api = await readFile(new URL('../public/llm/API.html', import.meta.url), 'utf8');
  expect(guide).toContain('<h1>co-ai：AI 操作指南</h1>');
  expect(guide).toContain('href="/llm/API.html"');
  expect(guide).toContain('&lt;API_KEY&gt;');
  expect(guide).not.toContain('<script');
  expect(api).toContain('<h1>REST API v1</h1>');
  expect(api).toContain('<table>');
  expect(api).toContain('updated_since');
  expect(api).toContain('recipient_role_ids');
  expect(await readFile(new URL('../public/llm/API.md', import.meta.url), 'utf8')).toBe(await readFile(new URL('../llm/API.md', import.meta.url), 'utf8'));
});
