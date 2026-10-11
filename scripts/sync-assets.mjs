import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import MarkdownIt from 'markdown-it';

const output = new URL('../public/llm/', import.meta.url);
await mkdir(output, { recursive: true });
await cp(new URL('../llm/', import.meta.url), output, { recursive: true });

// Render at build time so browsers and crawlers get the complete text without JavaScript.
const markdown = new MarkdownIt({ html: false });
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const href = tokens[index].attrGet('href');
  if (href && /^(?:\.\/)?(?:README|API)\.md(?:#.*)?$/.test(href)) {
    tokens[index].attrSet('href', '/llm/' + href.replace(/^\.\//, '').replace(/\.md(?=#|$)/, '.html'));
  }
  if (href && /^(?:\.\/)?openapi\.json(?:#.*)?$/.test(href)) {
    tokens[index].attrSet('href', '/llm/' + href.replace(/^\.\//, ''));
  }
  return renderer.renderToken(tokens, index, options);
};
const stylesheet = `:root{font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;color:#263c37;background:#f8faf6;line-height:1.75}body{max-width:960px;margin:auto;padding:24px}nav{display:flex;gap:18px;flex-wrap:wrap;padding:12px 0 24px;border-bottom:1px solid #dce3db}a{color:#276c51}main{padding-top:12px;overflow-wrap:anywhere}h1,h2,h3{line-height:1.35;margin-top:1.5em}pre{background:#edf1eb;padding:18px;border-radius:8px;overflow:auto;line-height:1.6}code{font-family:ui-monospace,monospace;font-size:.9em}table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #dce3db;padding:8px 12px;text-align:left}blockquote{border-left:3px solid #9cae9f;padding-left:16px;margin-left:0}footer{margin-top:40px;border-top:1px solid #dce3db;padding-top:16px;font-size:14px}@media(max-width:640px){body{padding:16px}pre{padding:12px}}\n`;
await writeFile(new URL('docs.css', output), stylesheet);
for (const [file, title] of [['README', 'AI 操作指南'], ['API', 'REST API 文档']]) {
  const source = await readFile(new URL(`../llm/${file}.md`, import.meta.url), 'utf8');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>co-ai · ${title}</title><link rel="stylesheet" href="/llm/docs.css"></head>
<body><nav aria-label="文档导航"><a href="/llm">AI 操作指南</a><a href="/llm/API.html">REST API 文档</a><a href="/llm/openapi.json">OpenAPI JSON</a><a href="/">管理工作台</a></nav><main>${markdown.render(source)}</main><footer><a href="/llm/${file}.md">Markdown 源文档</a></footer></body></html>\n`;
  await writeFile(new URL(`${file}.html`, output), html);
  if (file === 'README') await writeFile(new URL('index.html', output), html);
}
