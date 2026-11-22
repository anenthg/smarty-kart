// Neon Racer boot helper (classic script, runs before the game module).
//  * Shows a readable message on the loading screen if anything fails during start-up.
//  * ?debug=1      → forwards errors, console output and stats to POST /__log (printed in the Mac terminal).
//  * ?emulate=tv   → makes this browser behave like the family TV's GPU (Mali-450, WebGL 1 only):
//                    no WebGL 2, no instancing / uint32 indices / float textures / anisotropy / sRGB ext,
//                    no fragment highp, no vertex textures. Used to test TV compatibility on the Mac.
(function () {
  var Q = new URLSearchParams(location.search);

  window.__fatal = function (msg) {
    var t = document.getElementById('loadtxt'), l = document.getElementById('loading');
    if (l) l.classList.remove('hidden');
    if (t) { t.textContent = msg; t.style.color = '#ff9a9a'; t.style.maxWidth = '80vw'; t.style.textAlign = 'center'; }
  };
  window.addEventListener('error', function (e) {
    if (!window.__booted) window.__fatal('Something went wrong while starting: ' + (e.message || e.type));
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (!window.__booted) window.__fatal('Something went wrong while loading: ' + ((e.reason && e.reason.message) || e.reason));
  });

  // ------------------------------------------------------------ remote debug log
  if (Q.has('debug')) {
    var buf = [], timer = 0;
    var flush = function () {
      timer = 0;
      if (!buf.length) return;
      var body = JSON.stringify(buf.splice(0, buf.length));
      try { fetch('/__log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }); } catch (e) {}
    };
    var log = window.__dbgLog = function (type, msg) {
      var s;
      try { s = typeof msg === 'string' ? msg : JSON.stringify(msg); } catch (e) { s = String(msg); }
      buf.push({ type: type, msg: String(s).slice(0, 4000) });
      if (!timer) timer = setTimeout(flush, 700);
    };
    ['log', 'info', 'warn', 'error'].forEach(function (k) {
      var orig = console[k];
      console[k] = function () {
        try { log('console.' + k, Array.prototype.map.call(arguments, function (a) { return a && a.stack ? a.stack : (typeof a === 'object' ? JSON.stringify(a) : String(a)); }).join(' ')); } catch (e) {}
        return orig.apply(console, arguments);
      };
    });
    window.addEventListener('error', function (e) { log('error', (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '') + (e.error && e.error.stack ? '\n' + e.error.stack : '')); });
    window.addEventListener('unhandledrejection', function (e) { log('unhandledrejection', (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason)); });
    log('boot', navigator.userAgent + ' | viewport ' + innerWidth + 'x' + innerHeight + ' dpr ' + devicePixelRatio + (Q.get('emulate') ? ' | emulate=' + Q.get('emulate') : ''));
  }

  // ------------------------------------------------------------ TV GPU emulation
  if (Q.get('emulate') === 'tv') {
    var HIDE = ['ANGLE_instanced_arrays', 'OES_element_index_uint', 'OES_texture_float', 'OES_texture_float_linear',
      'OES_texture_half_float', 'OES_texture_half_float_linear', 'EXT_color_buffer_float', 'EXT_color_buffer_half_float',
      'WEBGL_color_buffer_float', 'EXT_texture_filter_anisotropic', 'WEBKIT_EXT_texture_filter_anisotropic', 'EXT_sRGB',
      'EXT_float_blend', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb', 'EXT_texture_compression_bptc',
      'EXT_texture_compression_rgtc', 'WEBGL_multi_draw', 'EXT_frag_depth', 'WEBGL_draw_buffers'];
    var orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (type === 'webgl2') return null;
      var gl = orig.call(this, type, attrs);
      if (gl && (type === 'webgl' || type === 'experimental-webgl') && !gl.__tv) {
        gl.__tv = true;
        var ge = gl.getExtension.bind(gl), gs = gl.getSupportedExtensions.bind(gl), gp = gl.getParameter.bind(gl), gsp = gl.getShaderPrecisionFormat.bind(gl);
        gl.getExtension = function (n) { return HIDE.indexOf(n) >= 0 ? null : ge(n); };
        gl.getSupportedExtensions = function () { return (gs() || []).filter(function (n) { return HIDE.indexOf(n) < 0; }); };
        gl.getParameter = function (p) {
          if (p === gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) return 0;
          if (p === gl.MAX_TEXTURE_IMAGE_UNITS) return 8;
          if (p === gl.MAX_TEXTURE_SIZE) return 4096;
          if (p === gl.SAMPLES) return 0;
          return gp(p);
        };
        gl.getShaderPrecisionFormat = function (st, pt) {
          if (st === gl.FRAGMENT_SHADER && pt === gl.HIGH_FLOAT) return { rangeMin: 0, rangeMax: 0, precision: 0 };
          return gsp(st, pt);
        };
        // catch anything that would fail on the TV
        var de = gl.drawElements.bind(gl);
        gl.drawElements = function (mode, count, t, off) {
          if (t === gl.UNSIGNED_INT && !window.__u32warned) { window.__u32warned = 1; console.error('TV-EMULATION: 32-bit index draw (would fail on the TV)'); }
          return de(mode, count, t, off);
        };
      }
      return gl;
    };
  }
})();
