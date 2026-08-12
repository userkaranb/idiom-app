/**
 * Server-rendered UI for the Worker.
 *
 *   styles.ts  — CSS, split into a shared base plus one block per page
 *   client.ts  — the browser script for the history feed
 *   pages.ts   — the document shell and the two page renderers
 *
 * Importers should only ever need this barrel; `./ui` resolves here.
 */
export { renderPage, renderLoginPage } from './pages';
