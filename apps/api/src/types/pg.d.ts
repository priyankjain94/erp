// Minimal typings for the parts of `pg` this app uses (kept local so no @types/pg is needed).
declare module 'pg' {
  export interface QueryResult<R = any> { rows: R[]; rowCount: number | null; command: string }
  export interface PoolClient { query<R = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>; release(err?: unknown): void }
  export class Pool {
    constructor(config?: { connectionString?: string; max?: number; ssl?: unknown; idleTimeoutMillis?: number });
    query<R = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: 'error', fn: (err: Error) => void): this;
  }
  export const types: { setTypeParser(oid: number, fn: (v: string) => unknown): void };
  const pg: { Pool: typeof Pool; types: typeof types };
  export default pg;
}
