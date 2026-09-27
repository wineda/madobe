/* madobe — アプリ本体
 *
 * 役割：
 *   - THREE.WebGLRenderer を1つだけ作り、全シーンで共有する
 *   - シーンの登録（madobe.register）・切替（URL ハッシュ）・破棄
 *   - シーン定義の params からスライダーを自動生成する
 *   - 共通ヘルパー（雨・波紋）を ctx.helpers で渡す
 *
 * シーンの契約は README.md を参照。
 */
(function () {
  'use strict';

  const registry = new Map(); // id -> シーン定義
  const order = [];           // 登録順の id
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  let started = false;
  let dom = null;
  let renderer = null;
  let clock = null;
  let current = null; // { id, def, scene, camera, params, handle, t, broken }
  let uiHidden = false;

  /* ================================================================ */
  /* 共通ヘルパー                                                      */
  /* ================================================================ */

  /**
   * 雨粒（LineSegments）。1粒＝2頂点で、落下方向ベクトルに沿って線分を伸ばす。
   * 着地時に onLand(x, z) を呼び、上端で再生成する。
   */
  function makeRain(THREE, scene, opts) {
    opts = opts || {};
    const max = Math.max(1, Math.floor(opts.max || 3000));
    const area = Object.assign({ x: 30, z: 30, top: 18 }, opts.area);
    const color = opts.color !== undefined ? opts.color : 0xaebcd6;
    const opacity = opts.opacity !== undefined ? opts.opacity : 0.55;

    const pos = new Float32Array(max * 6);
    const attr = new THREE.BufferAttribute(pos, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', attr);

    const px = new Float32Array(max);
    const py = new Float32Array(max);
    const pz = new Float32Array(max);
    const vel = new Float32Array(max); // 粒ごとの速度倍率
    const len = new Float32Array(max); // 粒ごとの線分の長さ係数
    for (let i = 0; i < max; i++) {
      px[i] = (Math.random() - 0.5) * area.x;
      py[i] = Math.random() * area.top;
      pz[i] = (Math.random() - 0.5) * area.z;
      vel[i] = 0.8 + Math.random() * 0.5;
      len[i] = 0.25 + Math.random() * 0.35;
    }

    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, fog: true });
    const mesh = new THREE.LineSegments(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);

    const dir = new THREE.Vector3();
    let drawn = -1;

    function update(dt, p, onLand) {
      p = p || {};
      const count = Math.max(0, Math.min(max, Math.floor(p.count !== undefined ? p.count : max)));
      const wind = p.wind || 0;
      const speed = p.speed || 26;
      dir.set(wind, -speed, 0);
      const dlen = dir.length() || 1;
      const halfX = area.x / 2;

      for (let i = 0; i < count; i++) {
        py[i] -= speed * vel[i] * dt;
        px[i] += wind * vel[i] * dt;
        if (py[i] < 0) {
          if (onLand) onLand(px[i], pz[i]);
          py[i] = area.top + Math.random() * 3;
          px[i] = (Math.random() - 0.5) * area.x - wind * 0.6;
          pz[i] = (Math.random() - 0.5) * area.z;
        }
        if (px[i] > halfX) px[i] -= area.x;
        else if (px[i] < -halfX) px[i] += area.x;

        const k = len[i] / dlen; // 線分の長さは速度に比例
        const o = i * 6;
        pos[o] = px[i];
        pos[o + 1] = py[i];
        pos[o + 2] = pz[i];
        pos[o + 3] = px[i] - dir.x * k;
        pos[o + 4] = py[i] - dir.y * k;
        pos[o + 5] = pz[i];
      }
      attr.needsUpdate = true;
      if (drawn !== count) {
        geo.setDrawRange(0, count * 2);
        drawn = count;
      }
    }

    return { mesh, update, max };
  }

  /**
   * 地面の波紋。RingGeometry のプールを使い回し、spawn(x, z) で広げる。
   */
  function makeRipples(THREE, scene, opts) {
    opts = opts || {};
    const count = Math.max(1, Math.floor(opts.count || 60));
    const color = opts.color !== undefined ? opts.color : 0xc9d6ea;
    const maxOpacity = opts.maxOpacity !== undefined ? opts.maxOpacity : 0.35;
    const speed = opts.speed !== undefined ? opts.speed : 1.4;

    const geo = new THREE.RingGeometry(0.85, 1, 32);
    const pool = [];
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.01;
      mesh.visible = false;
      scene.add(mesh);
      pool.push({ mesh, t: 1 });
    }
    let cursor = 0;

    function spawn(x, z) {
      const r = pool[cursor];
      cursor = (cursor + 1) % count;
      r.t = 0;
      r.mesh.position.x = x;
      r.mesh.position.z = z;
      r.mesh.scale.set(0.15, 0.15, 1);
      r.mesh.visible = true;
    }

    function update(dt) {
      for (let i = 0; i < count; i++) {
        const r = pool[i];
        if (r.t >= 1) {
          if (r.mesh.visible) r.mesh.visible = false;
          continue;
        }
        r.t += dt * speed;
        const s = 0.15 + r.t * 0.9;
        r.mesh.scale.set(s, s, 1);
        r.mesh.material.opacity = Math.max(0, 1 - r.t) * maxOpacity;
      }
    }

    return { spawn, update };
  }

  const helpers = { makeRain, makeRipples };

  /* ================================================================ */
  /* 登録                                                              */
  /* ================================================================ */

  function register(def) {
    if (!def || typeof def !== 'object') {
      throw new TypeError('madobe.register: シーン定義オブジェクトが必要です');
    }
    if (typeof def.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(def.id)) {
      throw new TypeError('madobe.register: id は英小文字・数字・ハイフンのみです: ' + def.id);
    }
    if (typeof def.create !== 'function') {
      throw new TypeError('madobe.register(' + def.id + '): create(ctx) が必要です');
    }
    if (registry.has(def.id)) {
      console.warn('madobe: シーン "' + def.id + '" は登録済みです。後の定義は無視します');
      return;
    }
    registry.set(def.id, def);
    order.push(def.id);
    if (started && dom) addTab(def);
  }

  /* ================================================================ */
  /* 起動                                                              */
  /* ================================================================ */

  function start() {
    if (started) return;
    started = true;

    dom = {
      stage: document.getElementById('stage'),
      tabs: document.getElementById('tabs'),
      name: document.getElementById('scene-name'),
      meta: document.getElementById('scene-meta'),
      controls: document.getElementById('controls'),
      params: document.getElementById('params'),
      hideBtn: document.getElementById('hide-ui'),
      fsBtn: document.getElementById('fullscreen'),
    };

    if (!window.THREE) {
      notice('three.js を読み込めませんでした。ネットワーク接続を確認して再読み込みしてください。');
      return;
    }
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch (e) {
      console.error(e);
      notice('WebGL を利用できないため描画できません。');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    dom.stage.appendChild(renderer.domElement);
    clock = new THREE.Clock();

    resize();
    window.addEventListener('resize', resize);

    order.forEach((id) => addTab(registry.get(id)));
    dom.controls.addEventListener('submit', (e) => e.preventDefault());
    dom.hideBtn.addEventListener('click', () => setHidden(true));
    dom.fsBtn.addEventListener('click', toggleFullscreen);
    dom.stage.addEventListener('pointerdown', () => { if (uiHidden) setHidden(false); });
    ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => {
      document.addEventListener(ev, updateFullscreenLabel);
    });
    window.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', () => {
      const id = idFromHash();
      if (id) show(id);
    });

    const first = idFromHash() || order[0];
    if (!first) {
      notice('シーンが登録されていません。src/scenes/ にファイルを置き、index.html で読み込んでください。');
      return;
    }
    show(first);
    if (location.hash.slice(1) !== first) history.replaceState(null, '', '#' + first);
    requestAnimationFrame(tick);
  }

  function idFromHash() {
    let id = location.hash.slice(1);
    try { id = decodeURIComponent(id); } catch (e) { /* そのまま */ }
    return registry.has(id) ? id : null;
  }

  /* ================================================================ */
  /* シーン切替                                                        */
  /* ================================================================ */

  function show(id) {
    if (!renderer) return false;
    const def = registry.get(id);
    if (!def) return false;
    if (current && current.id === id) return true;

    if (current) {
      const h = current.handle;
      try {
        if (h && typeof h.dispose === 'function') h.dispose();
      } catch (e) {
        console.error('madobe: シーン "' + current.id + '" の dispose に失敗', e);
      }
      disposeScene(current.scene);
      current = null;
    }
    notice(null);

    // シーンごとにレンダラ設定をリセット（シーン側が create 内で上書きしてよい）
    renderer.shadowMap.enabled = false;
    renderer.toneMappingExposure = 1;

    const w = dom.stage.clientWidth || 1;
    const hgt = dom.stage.clientHeight || 1;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, w / hgt, 0.1, 1000);
    camera.position.set(0, 2, 10);

    const params = {};
    (def.params || []).forEach((p) => { params[p.key] = p.value; });

    let handle = {};
    let broken = false;
    try {
      handle = def.create({ THREE, renderer, scene, camera, params, reduceMotion, helpers }) || {};
    } catch (e) {
      console.error('madobe: シーン "' + id + '" の作成に失敗', e);
      notice('シーン「' + (def.name || id) + '」を作成できませんでした。コンソールを確認してください。');
      broken = true;
    }

    current = { id, def, scene, camera, params, handle, t: 0, broken };
    setTitle(def);
    buildPanel();
    updateTabs();
    return true;
  }

  function disposeScene(scene) {
    const seen = new Set();
    const disposeTexture = (tex) => {
      if (tex && tex.isTexture && !seen.has(tex)) {
        seen.add(tex);
        tex.dispose();
      }
    };
    const disposeMaterial = (m) => {
      if (!m || seen.has(m)) return;
      seen.add(m);
      Object.keys(m).forEach((k) => disposeTexture(m[k]));
      if (m.uniforms) {
        Object.keys(m.uniforms).forEach((k) => {
          const u = m.uniforms[k];
          if (u) disposeTexture(u.value);
        });
      }
      m.dispose();
    };

    scene.traverse((obj) => {
      if (obj.geometry && !seen.has(obj.geometry)) {
        seen.add(obj.geometry);
        obj.geometry.dispose();
      }
      if (Array.isArray(obj.material)) obj.material.forEach(disposeMaterial);
      else if (obj.material) disposeMaterial(obj.material);
      if (obj.isLight) {
        if (typeof obj.dispose === 'function') obj.dispose();
        else if (obj.shadow && obj.shadow.map) obj.shadow.map.dispose();
      }
    });
    disposeTexture(scene.background);
    disposeTexture(scene.environment);
    while (scene.children.length) scene.remove(scene.children[scene.children.length - 1]);
  }

  /* ================================================================ */
  /* UI                                                                */
  /* ================================================================ */

  function addTab(def) {
    const a = document.createElement('a');
    a.href = '#' + def.id;
    a.textContent = def.name || def.id;
    a.dataset.id = def.id;
    dom.tabs.appendChild(a);
  }

  function updateTabs() {
    Array.from(dom.tabs.children).forEach((a) => {
      const on = !!current && a.dataset.id === current.id;
      if (on) {
        a.setAttribute('aria-current', 'true');
        try { a.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* 古いブラウザ */ }
      } else {
        a.removeAttribute('aria-current');
      }
    });
  }

  function setTitle(def) {
    dom.name.textContent = def.name || def.id;
    dom.meta.textContent = def.meta || '';
    document.title = (def.name || def.id) + ' · madobe';
  }

  // step の小数桁数に合わせて表示する（0.5 → 1桁、100 → 0桁）
  function decimalsOf(step) {
    if (step === undefined || step === null || step === 'any') return 2;
    const s = String(step);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }

  function buildPanel() {
    dom.params.textContent = '';
    if (!current) return;
    const { def, params, handle } = current;

    (def.params || []).forEach((p) => {
      const id = 'param-' + def.id + '-' + p.key;
      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = p.label || p.key;

      const input = document.createElement('input');
      input.type = 'range';
      input.id = id;
      input.min = String(p.min);
      input.max = String(p.max);
      input.step = p.step !== undefined ? String(p.step) : 'any';
      input.value = String(params[p.key]); // min/max/step の後に設定する

      const out = document.createElement('output');
      out.setAttribute('for', id);
      const digits = decimalsOf(p.step);
      const render = () => { out.value = Number(params[p.key]).toFixed(digits); };

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (Number.isNaN(v)) return;
        params[p.key] = v;
        render();
        if (handle && typeof handle.onParam === 'function') {
          try { handle.onParam(p.key, v); } catch (e) { console.error(e); }
        }
      });
      render();
      dom.params.append(label, input, out);
    });
  }

  function setHidden(v) {
    uiHidden = !!v;
    document.body.classList.toggle('hidden-ui', uiHidden);
    if (uiHidden && document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function updateFullscreenLabel() {
    dom.fsBtn.textContent = isFullscreen() ? '全画面を終了' : '全画面';
  }

  function toggleFullscreen() {
    const swallow = (r) => { if (r && typeof r.catch === 'function') r.catch(() => {}); };
    try {
      if (isFullscreen()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) swallow(exit.call(document));
      } else {
        const el = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) swallow(req.call(el));
      }
    } catch (e) {
      /* iOS Safari などは未対応。何もしない */
    }
  }

  function onKey(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') {
      if (uiHidden) setHidden(false);
      return;
    }
    const t = e.target;
    const tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    switch (e.key) {
      case 'h': case 'H': setHidden(!uiHidden); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'ArrowRight': case ']': step(1); break;
      case 'ArrowLeft': case '[': step(-1); break;
      default: return;
    }
    e.preventDefault();
  }

  function step(dir) {
    if (!current || order.length < 2) return;
    const i = order.indexOf(current.id);
    location.hash = order[(i + dir + order.length) % order.length];
  }

  function notice(msg) {
    let n = document.getElementById('notice');
    if (!msg) {
      if (n) n.remove();
      return;
    }
    if (!n) {
      n = document.createElement('div');
      n.id = 'notice';
      n.className = 'notice';
      document.body.appendChild(n);
    }
    n.textContent = msg;
  }

  /* ================================================================ */
  /* ループ                                                            */
  /* ================================================================ */

  function resize() {
    if (!renderer) return;
    const w = dom.stage.clientWidth || window.innerWidth;
    const h = dom.stage.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    if (current) {
      current.camera.aspect = w / h;
      current.camera.updateProjectionMatrix();
    }
  }

  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!current) return;
    current.t += dt;
    const h = current.handle;
    if (!current.broken && h && typeof h.update === 'function') {
      try {
        h.update(dt, current.t, current.params);
      } catch (e) {
        console.error('madobe: シーン "' + current.id + '" の update でエラー', e);
        current.broken = true;
        notice('シーン「' + (current.def.name || current.id) + '」の更新でエラーが起きました。コンソールを確認してください。');
      }
    }
    renderer.render(current.scene, current.camera);
  }

  /* ================================================================ */
  /* 公開 API                                                          */
  /* ================================================================ */

  window.madobe = {
    version: '0.1.0',
    register,
    start,
    show,
    helpers,
    get scenes() { return order.slice(); },
    get current() { return current ? current.id : null; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
