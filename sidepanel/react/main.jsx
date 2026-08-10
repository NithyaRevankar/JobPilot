import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.jsx';

/**
 * Entry point for the side panel.
 *
 * panel.css is linked from panel.html rather than imported here, so the page paints
 * styled before this script runs. Do not add a CSS import unless you also remove that
 * <link>, or the stylesheet ships twice.
 *
 * ON <StrictMode>: it is kept because it is the only thing that catches an effect with a
 * missing cleanup, and this app is full of imperative resources that need one — dialogs,
 * intervals, the AgentRunner, vault auto-lock timers. The cost is that in a DEVELOPMENT
 * build (`npm run dev`, which passes --mode development) React mounts every component
 * twice and runs every effect twice. Production builds (`npm run build`) do not. Write
 * effects that are idempotent and that clean up after themselves and both behave the
 * same; write one that appends instead of setting, and only the dev build will show it —
 * which is exactly the point.
 */
const container = document.getElementById('root');

if (!container) {
  // A blank side panel with a silent console is the worst possible failure mode,
  // so say what actually went wrong.
  throw new Error('[jobpilot] #root missing — sidepanel/panel.html is out of sync with main.jsx');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
