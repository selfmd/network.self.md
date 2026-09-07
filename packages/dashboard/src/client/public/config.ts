import type { PublicDestinations } from "../env";

/** Public destinations are build-time configuration, never operator credentials. */
const environment = (
  import.meta as ImportMeta & { readonly env: PublicDestinations }
).env;
function destination(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "https:" || url.protocol === "http:"
      ? value
      : fallback;
  } catch {
    return fallback;
  }
}
export const dashboardUrl = destination(
  environment.VITE_DASHBOARD_BASE_URL,
  "#/operator",
);
export const selfMdUrl = destination(
  environment.VITE_SELFMD_FILE_URL,
  "#/selfmd",
);
export function dashboardStateUrl(id: string) {
  if (dashboardUrl === "#/operator") return `#/state/${encodeURIComponent(id)}`;
  const url = new URL(dashboardUrl, window.location.href);
  url.hash = `/state/${encodeURIComponent(id)}`;
  return url.href;
}
export function selfMdEnforcementUrl() {
  if (selfMdUrl.startsWith("#/"))
    return `${selfMdUrl}${selfMdUrl.includes("?") ? "&" : "?"}section=enforcement`;
  const url = new URL(selfMdUrl, window.location.href);
  url.hash = "enforcement";
  return url.href;
}
