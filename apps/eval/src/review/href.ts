/** Eval-only. Query for the thread review page (`home` and optional focused run). */
export function reviewHref(
  threadId: string,
  opts?: { homeFlag?: string; runId?: string },
): string {
  const params = new URLSearchParams();
  if (opts?.homeFlag === 'eval') params.set('home', 'eval');
  if (opts?.runId) params.set('run', opts.runId);
  const query = params.toString();
  return `/threads/${threadId}/review${query ? `?${query}` : ''}`;
}
