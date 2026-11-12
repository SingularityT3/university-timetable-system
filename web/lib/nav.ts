/** Full-page navigation (a separate module so tests can mock it). */
export function go(url: string): void {
  window.location.assign(url);
}
