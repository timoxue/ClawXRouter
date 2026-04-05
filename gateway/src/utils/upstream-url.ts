export function buildOpenAIEndpoint(baseUrl: string, resourcePath: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  const pathOnly = normalizedBase.replace(/^https?:\/\/[^/]+/i, "");
  const hasVersionInPath = /\/v\d+(?:\/|$)/i.test(pathOnly);
  return hasVersionInPath
    ? `${normalizedBase}/${resourcePath}`
    : `${normalizedBase}/v1/${resourcePath}`;
}
