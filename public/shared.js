// ══════════════════════════════════════════════════════════
// SHIVA GROUP — UNIFIED SYNC + SESSION SYSTEM
// shared.js — included in ALL modules
// ══════════════════════════════════════════════════════════

// ── CONSTANTS ──
var SG_API = '/api';
var SG_CLIENT_ID = 'sg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
var SG_MODULE = document.documentElement.getAttribute('data-module') || 'erp';

// ── SESSION ──
function sgGetSession() {
  try {
    // Check sessionStorage first (passed from hub)
    var ss = sessionStorage.getItem('_sg_session');
    if (ss) {
      var obj = JSON.parse(ss);
      if (obj && (Date.now() - obj.ts) < 8 * 3600000) {
        localStorage.setItem('_sg_ls_session', ss);
        sessionStorage.removeItem('_sg_session');
        return obj;
      }
    }
    // Fall back to localStorage
    var ls = localStorage.getItem('_sg_ls_session');
    if (ls) {
      var obj2 = JSON.parse(ls);
      if (obj2 && (Date.now() - obj2.ts) < 8 * 3600000) return obj2;
    }
  } catch(e) {}
  return null;
}

function sgCheckAuth() {
  var sess = sgGetSession();
  if (!sess) {
    window.location.href = '/hub';
    return null;
  }
  return sess;
}

function sgLogout() {
  localStorage.removeItem('_sg_ls_session');
  sessionStorage.removeItem('_sg_session');
  window.location.href = '/hub';
}

// ── TOPBAR BUILDER ──
// Call this once in DOMContentLoaded with config:
// { moduleLabel: 'Textile ERP', syncId: 'syncDot', onHubClick: fn, extraBtns: [{icon,title,fn}] }
function sgBuildTopbar(config) {
  var sess = sgGetSession();
  var userName = sess ? sess.name.split(' ')[0] : 'User';
  var syncDotId = config.syncId || 'sgSyncDot';

  var extraBtns = (config.extraBtns || []).map(function(b) {
    return '<button class="sg-tbtn" onclick="' + b.fn + '" title="' + b.title + '">' + b.icon + '</button>';
  }).join('');

  var html =
    '<div class="sg-brand" onclick="window.location.href=\'/hub\'" style="cursor:pointer">' +
      '<div class="sg-logo">S</div>' +
      '<div class="sg-brand-text">' +
        '<div class="sg-brand-name">Shiva Group <span>ERP</span></div>' +
        '<div class="sg-brand-sub">Business Hub</div>' +
      '</div>' +
    '</div>' +
    '<div class="sg-spacer"></div>' +
    (config.moduleLabel ? '<span class="sg-module-badge">' + config.moduleLabel + '</span>' : '') +
    '<span id="' + syncDotId + '" class="sg-sync synced" title="All synced ✓">✓</span>' +
    extraBtns +
    '<button class="sg-tbtn" onclick="sgShowUserMenu()" id="sgUserBtn" title="' + userName + '">' +
      '<span style="font-size:11px;font-weight:700">' + (userName.charAt(0)||'U').toUpperCase() + '</span>' +
    '</button>';

  var tb = document.querySelector('.sg-topbar');
  if (tb) tb.innerHTML = html;
}

function sgShowUserMenu() {
  var sess = sgGetSession();
  if (!confirm((sess ? sess.name : 'User') + ' — Logout karo?')) return;
  sgLogout();
}

// ── SYNC ENGINE ──
// Universal sync: localStorage first, then cloud, SSE for real-time pull
// Usage: sgSync.init({ tables: {...}, apiBase: '/api', prefix: 'erp', onPull: fn })

var sgSync = (function() {
  var _dirty = false;
  var _pushing = false;
  var _lastSynced = {};
  var _sseConn = null;
  var _syncDotId = 'sgSyncDot';
  var _tables = {};
  var _apiBase = '/api';
  var _prefix = 'erp';
  var _onPull = null;
  var _clientId = SG_CLIENT_ID;

  function _dot(state, title) {
    var el = document.getElementById(_syncDotId);
    if (!el) return;
    el.className = 'sg-sync ' + state;
    el.title = title || state;
  }

  function _lsKey(k) { return '_sg_' + _prefix + '_' + k; }

  // Save all tables to localStorage instantly
  function _saveLocal() {
    try {
      var keys = Object.keys(_tables);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        localStorage.setItem(_lsKey(k), JSON.stringify(_tables[k]));
      }
    } catch(e) {}
  }

  // Restore from localStorage on page load
  function _restoreLocal() {
    var restored = 0;
    try {
      var keys = Object.keys(_tables);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var raw = localStorage.getItem(_lsKey(k));
        if (raw) {
          var parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) { _tables[k] = parsed; restored++; }
          else if (parsed && typeof parsed === 'object') { _tables[k] = parsed; restored++; }
        }
      }
    } catch(e) {}
    return restored;
  }

  // Push changed tables to cloud
  async function _push() {
    if (_pushing) return;
    _pushing = true;
    _dirty = false;
    _dot('saving', 'Saving to cloud...');
    var fail = 0;
    var keys = Object.keys(_tables);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var j = JSON.stringify(_tables[k]);
      if (_lastSynced[k] === j) continue; // unchanged, skip
      try {
        var r = await fetch(_apiBase + '/' + _prefix + '/' + encodeURIComponent(k), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-ID': _clientId },
          body: j
        });
        if (r.ok) { _lastSynced[k] = j; }
        else { fail++; _dirty = true; }
      } catch(e) { fail++; _dirty = true; }
    }
    _pushing = false;
    _dot(_dirty ? 'dirty' : 'synced', _dirty ? 'Some tables failed — retrying...' : 'All synced ✓');
  }

  // Pull from cloud (merge: remote wins if it has MORE records)
  async function _pull(silent) {
    if (!silent) _dot('saving', 'Loading from cloud...');
    try {
      var r = await fetch(_apiBase + '/' + _prefix + '-all', { cache: 'no-store' });
      if (!r.ok) return false;
      var remote = await r.json();
      var changed = 0;
      var keys = Object.keys(_tables);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!remote[k]) continue;
        var remoteArr = remote[k];
        var localArr = _tables[k] || [];
        if (Array.isArray(remoteArr)) {
          if (remoteArr.length > localArr.length) {
            _tables[k] = remoteArr;
            _lastSynced[k] = JSON.stringify(remoteArr);
            changed++;
          }
        }
      }
      if (changed > 0) {
        _saveLocal();
        if (_onPull) _onPull(changed);
      }
      _dot('synced', 'All synced ✓');
      return changed > 0;
    } catch(e) {
      _dot('dirty', 'Network error');
      return false;
    }
  }

  // SSE connection for real-time push from other devices
  function _startSSE() {
    if (_sseConn) { try { _sseConn.close(); } catch(e) {} }
    try {
      _sseConn = new EventSource(_apiBase + '/erp-events');
      _sseConn.addEventListener('data-changed', function() {
        if (!_pushing) _pull(true);
      });
      _sseConn.onmessage = function(e) {
        try {
          var msg = JSON.parse(e.data);
          if (msg.type === 'data_changed' && !_pushing) _pull(true);
        } catch(ex) {}
      };
      _sseConn.onerror = function() {
        if (_sseConn) { _sseConn.close(); _sseConn = null; }
        setTimeout(_startSSE, 5000);
      };
    } catch(e) {
      // Fallback polling every 5s
      setInterval(function() {
        if (!_pushing) _pull(true);
      }, 5000);
    }
  }

  return {
    init: function(cfg) {
      _tables  = cfg.tables;
      _apiBase = cfg.apiBase || '/api';
      _prefix  = cfg.prefix  || 'erp';
      _onPull  = cfg.onPull  || null;
      _syncDotId = cfg.syncDotId || 'sgSyncDot';

      // 1. Restore from localStorage
      _restoreLocal();

      // 2. Pull latest from cloud (merge)
      _pull(false).then(function() {
        // 3. Push our local state to cloud (seed if needed)
        _push();
      });

      // 4. SSE for real-time updates
      _startSSE();

      // 5. Auto-push every 3 seconds if dirty
      setInterval(function() {
        if (_dirty && !_pushing) _push();
      }, 3000);
    },

    // Call on every data change
    mark: function() {
      _dirty = true;
      _dot('dirty', 'Saving...');
      _saveLocal();
      // Immediate push (debounced 600ms via timeout)
      if (window._sgPushTimer) clearTimeout(window._sgPushTimer);
      window._sgPushTimer = setTimeout(_push, 600);
    },

    push: _push,
    pull: _pull,
    dot: _dot
  };
})();
