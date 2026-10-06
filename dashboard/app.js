/*
 * Hajiz console — shell, router and live state.
 *
 * No framework and no build step on purpose. This ships inside an appliance
 * that may be installed on a network with no route to npm, and a console that
 * needs a toolchain to patch is a console that does not get patched.
 *
 * Pages are ES modules under /pages. Each exports { title, render(mount, ctx) }
 * and may export stop() to release anything it subscribed to.
 */

import { renderMonitor } from './pages/monitor.js';
import { renderReview } from './pages/review.js';
import { renderPolicy } from './pages/policy.js';
import { renderAudit } from './pages/audit.js';
import { renderAppliance } from './pages/appliance.js';
import { renderApi } from './pages/api.js';
import { renderDeployment } from './pages/deployment.js';
import { renderHelp } from './pages/help.js';
import { renderPlaceholder } from './pages/placeholder.js';
import { renderSignIn } from './pages/signin.js';

// ------------------------------------------------------------------ routes --

const ROUTES = [
  { path: '/', id: 'monitor', label: 'Monitor', group: 'ops', icon: 'activity', render: renderMonitor },
  { path: '/review', id: 'review', label: 'Review Queue', group: 'ops', icon: 'inbox', badge: 'pendingEscalations', render: renderReview },
  { path: '/policy', id: 'policy', label: 'Policy', group: 'ops', icon: 'sliders', render: renderPolicy },
  { path: '/audit', id: 'audit', label: 'Audit', group: 'ops', icon: 'ledger', render: renderAudit },
  { path: '/deployment', id: 'deployment', label: 'Deployment', group: 'setup', icon: 'route', render: renderDeployment },
  { path: '/integrations', id: 'integrations', label: 'Integrations', group: 'setup', icon: 'plug' },
  { path: '/appliance', id: 'appliance', label: 'Appliance', group: 'setup', icon: 'server', render: renderAppliance },
  { path: '/api', id: 'api', label: 'API', group: 'setup', icon: 'code', render: renderApi },
  { path: '/help', id: 'help', label: 'Help', group: 'setup', icon: 'help', render: renderHelp },
];

const ICONS = {
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  inbox: 'M3 13h5l1.5 3h5L16 13h5M4 6h16l1 7v5H3v-5l1-7Z',
  sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M15 4v6M8 14v6',
  ledger: 'M5 3h11l3 3v15H5V3Zm3 6h8M8 13h8M8 17h5',
  route: 'M5 6h4a4 4 0 0 1 4 4v4a4 4 0 0 0 4 4h2M5 6a1.6 1.6 0 1 0 0-.1M19 18a1.6 1.6 0 1 0 0-.1',
  plug: 'M9 3v6M15 3v6M7 9h10v3a5 5 0 0 1-10 0V9Zm5 8v4',
  server: 'M4 5h16v5H4V5Zm0 9h16v5H4v-5Zm3-6.5h.01M7 16.5h.01',
  code: 'm9 7-5 5 5 5M15 7l5 5-5 5',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-1.8-10.5a1.8 1.8 0 1 1 2.6 1.6c-.5.3-.8.8-.8 1.4M12 17h.01',
};

// ------------------------------------------------------------------- state --

export const store = {
  state: null,
  connected: false,
  listeners: new Set(),

  set(next) {
    this.state = next;
    this.listeners.forEach((fn) => fn(next));
  },

  subscribe(fn) {
    this.listeners.add(fn);
    if (this.state) fn(this.state);
    return () => this.listeners.delete(fn);
  },
};

async function pullState() {
  try {
    const res = await fetch('/api/state');
    if (res.status === 401) return signOutToForm();
    if (!res.ok) throw new Error(`state ${res.status}`);
    store.set(await res.json());
    setConnection(true);
  } catch {
    setConnection(false);
  }
}

/**
 * Show the sign-in form over the whole window.
 *
 * The shell is replaced rather than hidden: a console still holding the last
 * page's numbers behind a login box invites someone to read figures that may
 * already be stale, and on a security appliance a stale number read as current
 * is worse than no number.
 */
function signOutToForm() {
  closeEventStream();
  document.body.innerHTML = '<div id="auth-root"></div>';
  renderSignIn(document.getElementById('auth-root'), {
    onSignedIn: () => window.location.reload(),
  });
}

function setConnection(ok) {
  store.connected = ok;
  const dot = document.getElementById('conn-dot');
  const text = document.getElementById('conn-text');
  dot.className = `dot ${ok ? 'dot--live' : 'dot--off'}`;
  text.textContent = ok ? 'Live' : 'Gateway unreachable';
}

/*
 * The gateway pushes an event per request over SSE. Rather than thread each
 * event type through the pages, any event re-pulls /api/state: the payload is
 * small, it keeps one source of truth, and a page never has to merge a partial
 * update into a list it is already showing.
 */
let eventSource = null;
let streamClosed = false;

function closeEventStream() {
  streamClosed = true;
  eventSource?.close();
}

function openEventStream() {
  let source;
  const connect = () => {
    if (streamClosed) return;
    source = new EventSource('/api/events');
    eventSource = source;
    source.onmessage = () => pullState();
    source.onopen = () => setConnection(true);
    source.onerror = () => {
      setConnection(false);
      source.close();
      setTimeout(connect, 3000);
    };
  };
  connect();
}

// ------------------------------------------------------------------ router --

let current = null;

function navigate(path, { replace = false } = {}) {
  const route = ROUTES.find((r) => r.path === path) ?? ROUTES[0];
  if (replace) history.replaceState({}, '', route.path);
  else history.pushState({}, '', route.path);
  show(route);
}

function show(route) {
  if (current?.stop) current.stop();
  current = null;

  // The page name is the body heading; the top bar carries the appliance.
  document.title = `${route.label} · Hajiz`;
  for (const el of document.querySelectorAll('.nav__item')) {
    el.toggleAttribute('aria-current', el.dataset.route === route.id);
    if (el.dataset.route === route.id) el.setAttribute('aria-current', 'page');
  }

  const mount = document.getElementById('page');
  mount.innerHTML = '';

  const render = route.render ?? ((m) => renderPlaceholder(m, route));
  current = render(mount, { store, navigate }) ?? null;
}

function buildNav() {
  for (const route of ROUTES) {
    const el = document.createElement('a');
    el.className = 'nav__item';
    el.href = route.path;
    el.dataset.route = route.id;
    el.title = route.label;
    el.innerHTML =
      `<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
      `stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[route.icon]}"/></svg>` +
      `<span>${route.label}</span>` +
      (route.badge ? `<span class="nav__badge" data-badge="${route.badge}" hidden>0</span>` : '');
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(route.path);
    });
    document.getElementById(route.group === 'ops' ? 'nav-ops' : 'nav-setup').append(el);
  }
}

// ------------------------------------------------------------------- theme --

function initTheme() {
  const saved = (() => {
    try {
      return localStorage.getItem('hajiz-theme');
    } catch {
      return null;
    }
  })();
  const preferred = saved ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(preferred);

  for (const btn of document.querySelectorAll('[data-theme-set]')) {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeSet));
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  for (const btn of document.querySelectorAll('[data-theme-set]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeSet === theme));
  }
  try {
    localStorage.setItem('hajiz-theme', theme);
  } catch {
    /* private window, or site data blocked - the theme simply will not persist */
  }
}

// ------------------------------------------------------------------- chrome -

function bindChrome() {
  store.subscribe((state) => {
    const name = document.getElementById('appliance-name');
    const mode = document.getElementById('appliance-mode');
    const dot = document.getElementById('appliance-dot');

    name.textContent = state.gateway ?? 'gw-local';
    const enforcing = state.enforcement === 'enforce';
    // Observing is amber rather than green on purpose: a gateway that is
    // watching and changing nothing looks identical to one that is protecting,
    // and the difference is the whole product.
    mode.textContent = enforcing ? 'Enforcing' : 'Observing';
    mode.title = enforcing
      ? 'Policy actions are applied to live traffic.'
      : 'Prompts are inspected and recorded, and forwarded unchanged.';
    dot.className = `dot ${enforcing ? 'dot--live' : 'dot--warn'}`;

    for (const badge of document.querySelectorAll('[data-badge]')) {
      const n = Number(state[badge.dataset.badge] ?? 0);
      badge.textContent = String(n);
      badge.hidden = n === 0;
    }
  });
}

/*
 * Collapsing the sidebar. The preference is per browser and survives reloads;
 * if storage is unavailable the toggle still works for the session, because a
 * control that silently does nothing is worse than one that forgets.
 */
function initSidebar() {
  const app = document.getElementById('app');
  const btn = document.getElementById('sidebar-toggle');

  const apply = (collapsed) => {
    app.classList.toggle('app--collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  };

  let collapsed = false;
  try {
    collapsed = localStorage.getItem('hajiz-sidebar') === 'collapsed';
  } catch {
    /* private window or blocked storage: start expanded */
  }
  apply(collapsed);

  btn.addEventListener('click', () => {
    collapsed = !collapsed;
    apply(collapsed);
    try {
      localStorage.setItem('hajiz-sidebar', collapsed ? 'collapsed' : 'expanded');
    } catch {
      /* the preference simply will not persist */
    }
  });
}

// --------------------------------------------------------------------- boot -

/*
 * Nothing starts until the appliance says there is a session. The console's
 * files are served to anyone who can reach the port - they hold no data - but
 * every byte of data is behind /api, and the gateway refuses those without a
 * session whatever this page decides to render.
 */
async function boot() {
  let status;
  try {
    status = await fetch('/api/auth/status').then((r) => r.json());
  } catch {
    // The gateway is unreachable. Showing the form is the honest state: there
    // is no session to speak of and nothing to display behind it.
    status = { signedIn: false };
  }

  if (!status.signedIn) {
    document.body.innerHTML = '<div id="auth-root"></div>';
    renderSignIn(document.getElementById('auth-root'), { onSignedIn: () => window.location.reload() });
    return;
  }

  initTheme();
  initSidebar();
  buildNav();
  bindChrome();
  addEventListener('popstate', () => navigate(location.pathname, { replace: true }));
  navigate(location.pathname, { replace: true });
  pullState();
  openEventStream();
}

boot();
