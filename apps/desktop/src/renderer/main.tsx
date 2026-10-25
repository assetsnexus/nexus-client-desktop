import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { CompanionView } from './components/CompanionView.js';
import { CompanionToolView } from './components/CompanionToolView.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { parseCompanionHash, parseCompanionToolHash } from '../shared/companion.js';
import { I18nProvider } from './i18n/index.js';

// Phase 7a: a companion window loads the same renderer with a `#companion?…`
// hash. Deliverable 3 adds `#companion-tool?…` for the detached context-menu
// tools (one BrowserWindow per agent). Any other hash (or none) is the app shell.
const companionTool = parseCompanionToolHash(window.location.hash);
const companion = companionTool ? null : parseCompanionHash(window.location.hash);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="Nexus">
      <I18nProvider>
        {companionTool ? (
          <CompanionToolView route={companionTool} />
        ) : companion ? (
          <CompanionView launch={companion} />
        ) : (
          <App />
        )}
      </I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
);
