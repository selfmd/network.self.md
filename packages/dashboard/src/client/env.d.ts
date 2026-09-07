/** Public URLs accepted by the Vite build; no credentials belong in these values. */
export interface PublicDestinations {
  readonly VITE_DASHBOARD_BASE_URL?: string;
  readonly VITE_SELFMD_FILE_URL?: string;
}
