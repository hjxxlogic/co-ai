import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Explicit maintenance operation: indexes only validated columns of an existing table.
const args = process.argv.slice(2);
const remote = args.includes('--remote'), local = args.includes('--local');
const tableId = args.find((arg) => arg.startsWith('--table-id='))?.slice(11);
const columns = args.find((arg) => arg.startsWith('--columns='))?.slice(10).split(',');
if (remote === local || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(tableId ?? '')
  || !columns?.length || columns.length > 20 || columns.some((column) => !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(column))) {
  throw new Error('Usage: node scripts/index-project-filters.mjs --remote|--local --table-id=<uuid> --columns=work_id,lesson_key [--apply]');
}
function execute(sql) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
    'd1', 'execute', 'DB', remote ? '--remote' : '--local', '--json', '--command', sql],
  { encoding: 'utf8', cwd: fileURLToPath(new URL('../', import.meta.url)) });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || 'Wrangler failed');
  return JSON.parse(result.stdout);
}
const table = execute(`SELECT columns_json FROM project_tables WHERE id = '${tableId}'`)[0].results[0];
if (!table) throw new Error('Table not found');
const schema = JSON.parse(table.columns_json);
const physical = 'project_data_' + tableId.replaceAll('-', '');
const statements = [...new Set(columns)].map((name) => {
  if (!schema.some((column) => column.name === name && column.type !== 'json')) throw new Error(`Unknown or unsupported index column: ${name}`);
  return `CREATE INDEX IF NOT EXISTS "${physical}_${name}_id" ON "${physical}" ("${name}", _id);`;
});
console.log(statements.join('\n'));
if (args.includes('--apply')) {
  for (const statement of statements) execute(statement);
  console.log(`Applied ${statements.length} indexes.`);
}
