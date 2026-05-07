import React from 'react';
import ReactDOM from 'react-dom/client';

import './styles/tokens.css';
import './styles/global.css';
import { RepairView } from './views/RepairView';

// Window dispatch — ?view=<name> in the URL drives which view renders.
// Each tray menu action that opens a window passes its own `view` value
// (commands.rs::open_or_focus_window). Default = a tiny placeholder
// because the Doctor is tray-first.
function App() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');

  if (view === 'repair') return <RepairView />;
  if (view === 'diagnostics') return <DiagnosticsPlaceholder />;
  return <DefaultPlaceholder />;
}

function DefaultPlaceholder() {
  return (
    <div className="placeholder">
      <h1>Factotem Doctor</h1>
      <p>
        This window opens on demand from the menu-bar icon. Click the
        Doctor in your menu bar to access Repair Stack, Diagnostic
        Details, and Open Dashboard.
      </p>
    </div>
  );
}

function DiagnosticsPlaceholder() {
  return (
    <div className="placeholder">
      <h1>Diagnostic details</h1>
      <p>
        Per-process / launchd / port-owner diagnostic surface. Lands as
        a follow-up to M1.3 — the probe data is already collected; this
        window just renders it.
      </p>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
