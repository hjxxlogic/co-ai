export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  DOCS: Fetcher;
  ADMIN_TOKEN: string;
  MCP_DEBUG_LOGS?: string;
}

export interface Principal {
  id: string;
  user_id: string;
  project_id: string | null;
  permission: 'read' | 'write';
}

export type AppEnv = { Bindings: Env; Variables: { principal: Principal } };
