/*
 * Audit — the record, and the proof that it has not been edited.
 *
 * Two things share this page because they only mean anything together. A list
 * of decisions nobody can verify is a log file with a nicer font; a
 * verification with no records beside it is a green tick with nothing behind
 * it. So the chain state sits above the records it vouches for, and when it
 * breaks it names the record and says which of the two checks failed.
 */

const ACTIONS = ['allow', 'pseudonymize', 'redact', 'escalate', 'block'];
const PAGE = 50;

export function renderAudit(mount, { store }) {
  mount.innerHTML = `
    <div class="pagehead__row">
      <h1 class="pagehead">Audit</h1>
      <span class="toolbar__sub" id="au-sub"></span>
      <span class="pagehead__spacer"></span>
      <input class="search" id="au-filter" placeholder="Filter by class, session or detector" />
      <select class="field field--text" id="au-action" style="height:28px;width:128px">
        <option value="">All actions</option>
        ${ACTIONS.map((a) => `<option value="${a}">${a}</option>`).join('')}
      </select>
      <button class="btn btn--sm" id="au-export">Export evidence</button>
      <button class="btn btn--sm btn--primary" id="au-verify">Verify chain</button>
    </div>

    <div id="au-chain"></div>

    <div class="panel" style="margin-top:12px">
      <div class="panel__head">
        <span class="panel__title">Records</span>
        <span class="panel__spacer"></span>
        <span class="panel__title" id="au-count" style="font-weight:400;color:var(--text-muted)"></span>
      </div>
      <div class="panel__body panel__body--flush" id="au-records"></div>
      <div class="row" id="au-pager" style="border-bottom:0"></div>
    </div>`;

  let offset = 0;
  let filter = '';
  let action = '';
  let expanded = null;
  let verification = null;

  const els = {
    chain: mount.querySelector('#au-chain'),
    records: mount.querySelector('#au-records'),
    count: mount.querySelector('#au-count'),
    pager: mount.querySelector('#au-pager'),
    sub: mount.querySelector('#au-sub'),
  };

  const loadRecords = async () => {
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (filter) q.set('filter', filter);
    if (action) q.set('action', action);
    try {
      const data = await fetch(`/api/audit?${q}`).then((r) => r.json());
      paintRecords(data);
    } catch {
      els.records.innerHTML = `<div class="empty">Could not read the log.</div>`;
    }
  };

  const verify = async () => {
    els.chain.innerHTML = `<div class="banner banner--info banner--slim">Walking the chain…</div>`;
    try {
      verification = await fetch('/api/audit/verify').then((r) => r.json());
    } catch (err) {
      verification = { ok: false, reason: 'unreachable', error: err.message };
    }
    paintChain();
  };

  function paintChain() {
    if (!verification) {
      els.chain.innerHTML = '';
      return;
    }

    if (verification.ok) {
      els.chain.innerHTML = `
        <div class="banner banner--info banner--slim">
          <span class="dot dot--live" style="margin-top:4px"></span>
          <span><strong>Chain intact.</strong> ${Number(verification.records ?? 0).toLocaleString()}
          record${verification.records === 1 ? '' : 's'} walked. Every record re-hashes to the value stored
          with it, and every link matches the record before it.
          ${verification.head ? `Head <span class="mono">${esc(verification.head.slice(0, 16))}</span>.` : ''}</span>
        </div>`;
      return;
    }

    const d = verification.detail ?? {};
    const isContent = verification.reason === 'content';
    els.chain.innerHTML = `
      <div class="banner banner--warn banner--slim" style="align-items:flex-start">
        <span class="dot dot--off" style="margin-top:4px"></span>
        <span>
          <strong>Chain broken at record ${esc(String(verification.brokenAt ?? '?'))}.</strong>
          ${isContent
            ? 'The record no longer matches the hash it was sealed with — its contents were edited after it was written.'
            : 'The link to the record before it does not match — a record was removed or reordered.'}
          ${verification.reason === 'unreachable' ? esc(verification.error ?? '') : ''}
        </span>
      </div>
      ${d.seq ? `<div class="panel">
        <div class="panel__head"><span class="panel__title">Why verification failed</span></div>
        <div class="panel__body panel__body--flush">
          <div class="row"><div class="row__label"><strong>Hash sealed with the record</strong></div>
            <span class="mono muted">${esc((d.sealedHash ?? '').slice(0, 24))}</span></div>
          <div class="row"><div class="row__label"><strong>Re-hash of the contents today</strong>
            <div class="row__help">${d.contentMatches ? 'matches' : 'does not match — the record was altered'}</div></div>
            <span class="mono" style="color:var(--${d.contentMatches ? 'allow' : 'block'})">${esc((d.rehashed ?? '').slice(0, 24))}</span></div>
          <div class="row"><div class="row__label"><strong>Link to the previous record</strong>
            <div class="row__help">${d.linkMatches ? 'matches' : 'does not match — a record was removed or reordered'}</div></div>
            <span class="mono" style="color:var(--${d.linkMatches ? 'allow' : 'block'})">${esc((d.storedPrev ?? '').slice(0, 24))}</span></div>
          ${d.requestId ? `<div class="row"><div class="row__label"><strong>Request</strong>
            <div class="row__help">${esc(d.ts ?? '')}</div></div>
            <span class="mono muted">${esc(d.requestId)}</span></div>` : ''}
        </div>
      </div>` : ''}`;
  }

  function paintRecords(data) {
    const records = data.records ?? [];
    els.count.textContent = `${data.total?.toLocaleString() ?? 0} matching`;
    els.sub.textContent = 'one hash-chained record per request';

    if (!records.length) {
      els.records.innerHTML = offset || filter || action
        ? `<div class="empty">Nothing matches.</div>`
        : `<div class="emptyState">
             <div class="orb" style="--orb-a:#4a4a7a;--orb-b:#8a7ab8"></div>
             <div class="emptyState__body">
               <p class="emptyState__title">The log is empty</p>
               <p class="emptyState__text">Every request the gateway handles is written here as one
               hash-chained record — what was found and what was decided, never the sensitive values
               themselves.</p>
             </div></div>`;
      els.pager.innerHTML = '';
      return;
    }

    const rows = records.map((r) => {
      const classes = Object.entries(r.byClass ?? {})
        .map(([cls, n]) => `${cls}${n > 1 ? `×${n}` : ''}`)
        .join(' ');
      const open = expanded === r.seq;
      return `
        <tr class="hoverable" data-seq="${r.seq}" style="cursor:pointer">
          <td class="mono faint">${r.seq}</td>
          <td class="mono faint" style="white-space:nowrap">${time(r.ts)}</td>
          <td class="mono">${esc(r.sessionId ?? 'anon')}</td>
          <td class="muted">${esc(r.group ?? '—')}</td>
          <td>${classes ? esc(classes) : '<span class="faint">—</span>'}</td>
          <td class="muted">${esc((r.detectors ?? []).join(' ') || '—')}</td>
          <td><span class="pill pill--${r.action}">${esc(r.action ?? '')}</span></td>
          <td class="mono muted" style="text-align:right;white-space:nowrap">${esc((r.hash ?? '').slice(0, 10))}</td>
        </tr>
        ${open ? `<tr><td colspan="8" style="background:var(--surface-sunken)">
          <div style="padding:4px 2px 10px">
            <div class="metric__label" style="margin-bottom:6px">Record as sealed</div>
            <pre class="mono" style="white-space:pre-wrap;font-size:12px;margin:0">${esc(JSON.stringify(r, null, 2))}</pre>
          </div></td></tr>` : ''}`;
    }).join('');

    els.records.innerHTML = `
      <table class="data data--dense">
        <thead><tr><th>#</th><th>Time</th><th>Session</th><th>Group</th><th>Found</th>
        <th>Detectors</th><th>Action</th><th style="text-align:right">Hash</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="row" style="border-top:1px solid var(--border);border-bottom:0">
        <div class="row__help">Records carry the classes that were found, never the values. The prompt
        text is not in this log and cannot be recovered from it.</div>
      </div>`;

    for (const tr of els.records.querySelectorAll('[data-seq]')) {
      tr.addEventListener('click', () => {
        const seq = Number(tr.dataset.seq);
        expanded = expanded === seq ? null : seq;
        paintRecords(data);
      });
    }

    const total = data.total ?? 0;
    els.pager.innerHTML = `
      <div class="row__help">Showing ${offset + 1}–${Math.min(offset + records.length, total)} of ${total.toLocaleString()}</div>
      <span class="row__label"></span>
      <button class="btn btn--sm" id="au-prev" ${offset === 0 ? 'disabled' : ''}>Newer</button>
      <button class="btn btn--sm" id="au-next" ${offset + PAGE >= total ? 'disabled' : ''}>Older</button>`;
    els.pager.querySelector('#au-prev')?.addEventListener('click', () => {
      offset = Math.max(0, offset - PAGE);
      expanded = null;
      loadRecords();
    });
    els.pager.querySelector('#au-next')?.addEventListener('click', () => {
      offset += PAGE;
      expanded = null;
      loadRecords();
    });
  }

  mount.querySelector('#au-verify').addEventListener('click', verify);
  mount.querySelector('#au-export').addEventListener('click', () => {
    const q = new URLSearchParams();
    if (filter) q.set('filter', filter);
    if (action) q.set('action', action);
    // Served with a content-disposition, so the browser saves it rather than
    // rendering a very large JSON document into the console.
    window.location.href = `/api/audit/export?${q}`;
  });

  let debounce;
  mount.querySelector('#au-filter').addEventListener('input', (e) => {
    filter = e.target.value.trim();
    offset = 0;
    clearTimeout(debounce);
    debounce = setTimeout(loadRecords, 220);
  });
  mount.querySelector('#au-action').addEventListener('change', (e) => {
    action = e.target.value;
    offset = 0;
    loadRecords();
  });

  loadRecords();
  verify();

  // A new request appends a record, so the newest page is stale the moment it
  // is drawn. Only refresh when sitting on it - paging back through history
  // must not jump under the reader.
  const unsubscribe = store.subscribe(() => {
    if (offset === 0) loadRecords();
  });

  return {
    stop() {
      clearTimeout(debounce);
      unsubscribe();
    },
  };
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const time = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString([], { hour12: false });
};
