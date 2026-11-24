'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const loginView = $('login'), appView = $('app'), tools = $('tools');
  const list = $('list'), empty = $('empty'), emptyText = $('emptyText'), appErr = $('appErr'), stats = $('stats');
  const tpl = $('card');
  let all = [], filter = 'all', search = '';

  const KIND = { quote: 'Free quote', call: 'Free call' };
  const OPEN = ['contacted', 'quote_sent'];

  async function api(path, opts = {}) {
    const method = opts.method || 'GET';
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(opts.body || {}),
    });
    if (res.status === 401 && path !== '/api/admin/login') { showLogin(); throw new Error('logged out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  function showLogin() {
    appView.hidden = true; tools.hidden = true; loginView.hidden = false;
    $('pw').focus();
  }
  function showApp() {
    loginView.hidden = true; appView.hidden = false; tools.hidden = false;
  }

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('loginErr').textContent = '';
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: $('pw').value } });
      $('pw').value = '';
      await load();
    } catch (err) { $('loginErr').textContent = err.message; }
  });
  $('logout').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {});
    all = []; list.textContent = ''; showLogin();
  });

  async function load() {
    try {
      const { requests } = await api('/api/admin/requests');
      all = requests;
      appErr.textContent = '';
      showApp();
      render();
    } catch (err) {
      if (err.message !== 'logged out') appErr.textContent = err.message;
    }
  }

  function stat(n, label) {
    const d = document.createElement('div');
    const b = document.createElement('b'); b.textContent = n;
    const s = document.createElement('span'); s.textContent = label;
    d.append(b, s);
    return d;
  }

  function matches(r) {
    if (filter === 'new' && r.status !== 'new') return false;
    if ((filter === 'quote' || filter === 'call') && r.kind !== filter) return false;
    if (filter === 'open' && !OPEN.includes(r.status)) return false;
    if (filter === 'won' && r.status !== 'won') return false;
    if (search) {
      const hay = (r.name + ' ' + r.contact + ' ' + r.message + ' ' + r.notes).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }

  // turn what the visitor typed into email, WhatsApp and call links
  function contactLinks(contact) {
    const links = [];
    const add = (label, href, newTab) => {
      const a = document.createElement('a');
      a.className = 'btn sm'; a.textContent = label; a.href = href;
      if (newTab) { a.target = '_blank'; a.rel = 'noopener'; }
      links.push(a);
    };
    const email = contact.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    if (email) add('Email', 'mailto:' + email[0]);
    let digits = contact.replace(/[^\d+]/g, '');
    if (!email && digits.replace(/\D/g, '').length >= 7) {
      if (digits.startsWith('00')) digits = '+' + digits.slice(2);
      let intl = digits.replace(/\D/g, '');
      if (!digits.startsWith('+') && intl.length === 8) intl = '357' + intl; // 8-digit number: Cyprus
      add('WhatsApp', 'https://wa.me/' + intl, true);
      add('Call', 'tel:' + (digits.startsWith('+') || intl.length > 8 ? '+' + intl : digits));
    }
    return links;
  }

  function renderStats() {
    const counts = {
      new: all.filter(r => r.status === 'new').length,
      quote: all.filter(r => r.kind === 'quote').length,
      call: all.filter(r => r.kind === 'call').length,
    };
    stats.replaceChildren(stat(counts.new, 'new'), stat(counts.quote, 'quotes'), stat(counts.call, 'calls'), stat(all.length, 'total'));
  }

  function render() {
    renderStats();

    const shown = all.filter(matches);
    list.replaceChildren(...shown.map(card));
    empty.hidden = shown.length > 0;
    emptyText.textContent = all.length
      ? 'Nothing matches this filter.'
      : 'No requests yet. They appear here as soon as someone sends the form on your site.';
  }

  function card(r) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.classList.toggle('is-new', r.status === 'new');
    li.querySelector('.kind').textContent = KIND[r.kind] || r.kind;
    const when = li.querySelector('.when');
    when.dateTime = r.created_at;
    when.textContent = new Date(r.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    li.querySelector('.name').textContent = r.name;
    li.querySelector('.contact').textContent = r.contact;
    li.querySelector('.acts').replaceChildren(...contactLinks(r.contact));
    const time = li.querySelector('.time');
    time.textContent = r.best_time ? 'Best time to call: ' + r.best_time : '';
    time.hidden = !r.best_time;
    const msg = li.querySelector('.msg');
    msg.textContent = r.message || 'No project description.';

    const status = li.querySelector('.status');
    const notes = li.querySelector('.notes');
    const saved = li.querySelector('.saved');
    const id = 'r' + r.id;
    status.id = id + 's'; li.querySelector('.st').htmlFor = id + 's';
    notes.id = id + 'n'; li.querySelector('.nt').htmlFor = id + 'n';
    status.value = r.status;
    notes.value = r.notes;

    const save = async body => {
      saved.textContent = 'Saving…';
      try {
        const { request } = await api('/api/admin/requests/' + r.id, { method: 'PATCH', body });
        Object.assign(r, request);
        saved.textContent = 'Saved';
        li.classList.toggle('is-new', r.status === 'new');
        renderStats();
      } catch (err) { saved.textContent = err.message; }
    };
    status.addEventListener('change', () => save({ status: status.value }));
    li.querySelector('.save').addEventListener('click', () => save({ notes: notes.value }));

    const del = li.querySelector('.del');
    let armed = false, timer;
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true; del.textContent = 'Confirm delete'; del.classList.add('danger');
        timer = setTimeout(() => { armed = false; del.textContent = 'Delete'; del.classList.remove('danger'); }, 4000);
        return;
      }
      clearTimeout(timer);
      try {
        await api('/api/admin/requests/' + r.id, { method: 'DELETE' });
        all = all.filter(x => x.id !== r.id);
        render();
      } catch (err) { saved.textContent = err.message; }
    });
    return li;
  }

  document.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.f;
    document.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  $('search').addEventListener('input', e => { search = e.target.value.trim().toLowerCase(); render(); });

  // refresh when you come back to the tab, unless you are typing
  document.addEventListener('visibilitychange', () => {
    const typing = document.activeElement && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);
    if (document.visibilityState === 'visible' && !appView.hidden && !typing) load();
  });

  load();
})();
