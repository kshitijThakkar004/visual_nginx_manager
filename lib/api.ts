export async function api(route: string, body?: unknown, method = 'POST') {
  const response = await fetch(
    '/api/' + route,
    body === undefined
      ? {}
      : {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
