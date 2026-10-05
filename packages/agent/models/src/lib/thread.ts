/**
 * A conversation thread. The top-level durable entity.
 *
 * Owned by the client (IndexedDB). The server is stateless and does not
 * persist threads — it receives full message context per run.
 */
export interface Thread {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}