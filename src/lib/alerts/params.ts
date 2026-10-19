// Route parameter helper for /api/alerts/[key]/... (the key has colons, so it arrives encoded).
export type KeyCtx = { params: Promise<{ key: string }> };

export async function alertKeyParam(ctx: KeyCtx): Promise<string> {
  const { key } = await ctx.params;
  try {
    return key.includes("%") ? decodeURIComponent(key) : key;
  } catch {
    return "";
  }
}
