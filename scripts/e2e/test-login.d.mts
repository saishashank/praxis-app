export function testLogin(
  baseUrl: string,
  secret: string,
  email: string,
  fetchImpl?: typeof fetch,
): Promise<string>;
