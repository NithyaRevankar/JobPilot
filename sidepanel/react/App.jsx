/**
 * App.jsx — the panel shell: header, status pill, tab bar, the five view slots, and the
 * two singleton hosts (toasts and modals).
 *
 * This is a port of the outer 50 lines of the old panel.html plus switchTab / setPill /
 * refreshPill / isConfigured from panel.js. The markup is deliberately identical — same
 * elements, same class names, same ids, same role="tablist" / role="tab" / aria-selected —
 * because sidepanel/panel.css is UNCHANGED and styles this by class. Nothing here may be
 * "tidied up" without editing CSS that is out of scope.
 *
 * ALL FIVE VIEWS STAY MOUNTED. panel.html kept five <section class="view"> in the document
 * and toggled `.active`; only the active one is `display: flex`. That is not just a CSS
 * detail — ChatView's RunView owns the AgentRunner, the live transcript and the target-tab poll, and
 * a run continues while the user reads Settings. Unmounting the inactive views would
 * destroy a run in progress. Views are mounted once `ready` is true and then never
 * unmounted; visibility is the `active` class alone.
 */

import { ModalHost } from './components/Modal.jsx';
import { ToastHost } from './components/Toast.jsx';
import { StoreProvider, useAppShell } from './state/store.jsx';
import { RunsProvider } from './state/runs-context.jsx';

import ChatView from './views/ChatView.jsx';
import ProfileView from './views/ProfileView.jsx';
import MemoryView from './views/MemoryView.jsx';
import VaultView from './views/VaultView.jsx';
import SettingsView from './views/SettingsView.jsx';

/**
 * The tab bar, in order. Each glyph is the same inline SVG panel.html carried — they are
 * one-offs that never appeared in panel.js's ICON_PATHS table, so they stay here rather
 * than moving into components/Icon.jsx.
 */
const VIEWS = [
  {
    key: 'chat',
    label: 'Chat',
    View: ChatView,
    glyph: (
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <path d="M3 4.5h14v9H8l-3.5 3v-3H3z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: 'profile',
    label: 'Profile',
    View: ProfileView,
    glyph: (
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <circle cx="10" cy="7" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M4 16.5c1.2-2.8 3.4-4 6-4s4.8 1.2 6 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: 'memory',
    label: 'Memory',
    View: MemoryView,
    glyph: (
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <path
          d="M5 3.5h8.5a1.5 1.5 0 0 1 1.5 1.5v11.5H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M7 7h5M7 10h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: 'vault',
    label: 'Vault',
    View: VaultView,
    glyph: (
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <rect x="4" y="9" width="12" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: 'settings',
    label: 'Settings',
    View: SettingsView,
    glyph: (
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M10 2.8v2.4M10 14.8v2.4M2.8 10h2.4M14.8 10h2.4M4.9 4.9l1.7 1.7M13.4 13.4l1.7 1.7M15.1 4.9l-1.7 1.7M6.6 13.4l-1.7 1.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

function Header() {
  const { pill } = useAppShell();
  return (
    <header className="header">
      <div className="brand">
        <svg className="logo" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M12 2 L21 7 v6 c0 4.5-3.5 8-9 9 -5.5-1-9-4.5-9-9 V7 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path
            d="M8.5 12.2 l2.4 2.4 4.6-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="brand-name">JobPilot</span>
      </div>
      {/* setPill wrote `status-pill status-${state}` and the label as textContent. */}
      <div id="status-pill" className={`status-pill status-${pill.state}`}>
        <span className="status-dot" />
        <span id="status-text">{pill.label}</span>
      </div>
    </header>
  );
}

function TabBar() {
  const { tab, setTab } = useAppShell();
  return (
    <nav className="tabbar" role="tablist">
      {VIEWS.map(({ key, label, glyph }) => {
        const active = tab === key;
        return (
          <button
            key={key}
            id={`tab-${key}`}
            className={'tab' + (active ? ' active' : '')}
            data-view={key}
            role="tab"
            aria-selected={active}
            onClick={() => setTab(key)}
          >
            {glyph}
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function Shell() {
  const { ready, tab } = useAppShell();
  return (
    <>
      <div id="app">
        <Header />
        <TabBar />
        {VIEWS.map(({ key, View }) => (
          <section key={key} id={`view-${key}`} className={'view' + (tab === key ? ' active' : '')}>
            {/* Gated on `ready` so no screen ever has to render against a null settings
                or profile. The store fills both from chrome.storage before this flips. */}
            {ready ? <View /> : null}
          </section>
        ))}
      </div>
      {/* Siblings of #app, exactly where panel.html put them: .toast-container is
          position:fixed and a <dialog> opened with showModal() renders in the top layer,
          so neither belongs inside the flex column that #app is. */}
      <ToastHost />
      <ModalHost />
    </>
  );
}

export default function App() {
  return (
    <StoreProvider>
      {/* Inside the store, because it feeds the store's `running` flag and registers the
          one aggregate chat handle Settings reaches every run through. */}
      <RunsProvider>
        <Shell />
      </RunsProvider>
    </StoreProvider>
  );
}
