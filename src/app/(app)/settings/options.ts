// Option lists shared by the Settings page and its detail pages.
export type Option = [string, string];

export const DELIVERY: Option[] = [
  ["immediate", "Immediately"],
  ["digest", "In the digest"],
];
export const TIME_FORMAT: Option[] = [
  ["24h", "24-hour (13:30)"],
  ["12h", "12-hour (1:30 pm)"],
];
export const TIMES_IN: Option[] = [
  ["melbourne", "Melbourne time"],
  ["exchange", "Exchange-local time"],
];
