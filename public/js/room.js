// Room helper (classic script, loaded before the game modules): every TV screen has its own room so several homes can
// share one hosted server. The TV makes up a short code once and remembers it; phones get it from the QR (/play?room=…).
(function () {
  var ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L
  var q = new URLSearchParams(location.search);
  function clean(v) { v = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return v.length >= 3 && v.length <= 8 ? v : ''; }
  function get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  // TV side: ?room=XXXX overrides; otherwise the remembered code; otherwise a new one
  function tvRoom() {
    var r = clean(q.get('room')) || clean(get('kr_room'));
    if (!r) { r = ''; for (var i = 0; i < 4; i++) r += ALPHA[Math.floor(Math.random() * ALPHA.length)]; }
    set('kr_room', r);
    return r;
  }
  // phone side: from the QR link, else the last room this phone used (may be '' → ask)
  function padRoom() {
    var r = clean(q.get('room'));
    if (r) set('kr_proom', r);
    return r || clean(get('kr_proom'));
  }
  function wsBase() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/'; }
  window.KR = {
    clean: clean,
    tvRoom: tvRoom,
    padRoom: padRoom,
    setPadRoom: function (r) { r = clean(r); if (r) set('kr_proom', r); return r; },
    tvSocket: function () { return wsBase() + '?role=tv&room=' + encodeURIComponent(tvRoom()); },
    padSocket: function (id, name, room) {
      return wsBase() + '?role=pad&id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name) + (room ? '&room=' + encodeURIComponent(room) : '');
    },
  };
})();
