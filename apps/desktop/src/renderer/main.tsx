import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { CompanionView } from './components/CompanionView.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { parseCompanionHash } from '../shared/companion.js';
import { I18nProvider } from './i18n/index.js';

// Phase 7a: a companion window loads the same renderer with a `#companion?…`
// hash. Any other hash (or none) is the normal app shell.
const companion = parseCompanionHash(window.location.hash);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="Nexus">
      <I18nProvider>{companion ? <CompanionView launch={companion} /> : <App />}</I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
);
