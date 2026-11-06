// Acquire the data-folder lock before importing index.ts, which opens and may migrate the database.
import { acquireServerLock } from './server-lock.ts';

export async function bootstrapServer(port?: number) {
  const releaseLock = acquireServerLock();
  try {
    const { DEFAULT_PORT, startServerWithLock } = await import('./index.ts');
    return await startServerWithLock(port ?? DEFAULT_PORT, releaseLock);
  } catch (error) {
    releaseLock();
    throw error;
  }
}
