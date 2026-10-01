import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
// Before App, so each view's stylesheet loads after the shared one and can override it.
import './styles.css';
import { App } from './App';
import { WebCore } from './core/webCore';

const core = new WebCore();
// Dev-only handle for poking the engine from the console.
if (import.meta.env.DEV) Object.assign(window, { core });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App core={core} />
  </StrictMode>,
);
