import React from 'react';
import ReactDOM from 'react-dom/client';

// M1.2 placeholder — the WebView never opens a window in M1.2 because
// the app is tray-only. M1.3 mounts the Repair Stack window here.

const App: React.FC = () => {
  return (
    <div style={{ fontFamily: 'system-ui', padding: '2rem' }}>
      <h1 style={{ marginTop: 0 }}>Factotem Doctor</h1>
      <p style={{ color: '#86868b' }}>
        Status windows are not yet implemented (lands in M1.3). The tray
        icon and the Open Dashboard / Open Recovery Panel actions are
        the working surface in M1.2.
      </p>
    </div>
  );
};

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
