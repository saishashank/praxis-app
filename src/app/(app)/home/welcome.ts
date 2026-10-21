// Name of the cookie that records a dismissed welcome banner (UX-012a). One per user, so a shared
// device shows the banner to each new person once. Plain module (not "use server"): it is also read by the page.
export const welcomeCookieName = (userId: number): string => `praxis_welcome_u${userId}`;
