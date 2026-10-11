import { cp, mkdir } from 'node:fs/promises';
await mkdir(new URL('../public/llm/', import.meta.url), { recursive: true });
await cp(new URL('../llm/', import.meta.url), new URL('../public/llm/', import.meta.url), { recursive: true });
