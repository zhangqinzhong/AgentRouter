// URLSearchParams is not transferable through worker_threads in Electron.
// Encode form bodies before crossing the bridge, preserving fetch semantics.
export function collectorFetchOptions(init: RequestInit): Omit<RequestInit, "signal"> {
  const { signal: _, ...options } = init;
  const headers = new Headers(init.headers);
  if (options.body instanceof URLSearchParams) {
    options.body = options.body.toString();
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  }
  return { ...options, headers: Object.fromEntries(headers) };
}
