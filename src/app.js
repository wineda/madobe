/* madobe — アプリ本体
 *
 * 役割：
 *   - THREE.WebGLRenderer を1つだけ作り、全シーンで共有する
 *   - シーンの登録（madobe.register）・切替（URL ハッシュ）・破棄
 *   - シーン定義の params からスライダーを自動生成する
 *   - PWA：Service Worker の登録と「インストール」ボタン
 *   - 共通ヘルパー（雨・波紋・草・炎・ポストエフェクト）を ctx.helpers で渡す
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

  /**
   * 風に揺れる草むら。3枚の葉を交差させた「株」を InstancedMesh で count 個並べ（1ドローコール）、
   * 頂点シェーダーで根元を固定したまま先端を曲げる。株の向きと揺れの位相は位置から決めるので
   * 追加の属性は不要。影は受けるが落とさない（深度マテリアルが揺れに追従しないため）。
   */
  const GRASS_PREFIX = 'uniform float uTime;\nuniform float uWind;\nuniform float uSway;\nuniform float uGustPhase;\nuniform float uGustAmp;\n';
  const GRASS_NORMAL = `
    vec2 gPos = vec2(0.0);
    #ifdef USE_INSTANCING
      gPos = instanceMatrix[3].xz;
    #endif
    float gHash = fract(sin(dot(gPos, vec2(12.9898, 78.233))) * 43758.5453);
    float gAng = gHash * 6.2831853;
    mat2 gRot = mat2(cos(gAng), -sin(gAng), sin(gAng), cos(gAng));
    vec3 objectNormal = vec3(normal);
    objectNormal.xz = gRot * objectNormal.xz;
    #ifdef USE_TANGENT
      vec3 objectTangent = vec3(tangent.xyz);
    #endif
  `;
  const GRASS_BEND = `
    vec3 transformed = vec3(position);
    transformed.xz = gRot * transformed.xz;
    {
      float gH = clamp(position.y, 0.0, 1.0);
      float gB = gH * gH;
      float gPh = gHash * 6.2831853;
      float gWave = sin(uTime * 1.7 - gPos.x * 0.35 + gPos.y * 0.2 + gPh * 0.5);
      float gFlutter = sin(uTime * 3.1 + gPh) * 0.5 + sin(uTime * 5.3 + gPh * 2.3) * 0.25;
      float gAmp = uSway * (0.06 + abs(uWind) * 0.025);
      vec2 gDir = vec2(uWind * 0.07 + (gWave + gFlutter * 0.5) * gAmp, (gWave * 0.5 + gFlutter) * gAmp * 0.6);
      // 草原を渡っていく突風の波（uGustAmp が 0 なら無効）。風下へ進む帯状の押し倒し
      float gGust = pow(max(sin(gPos.x * 0.22 * sign(uWind + 1e-4) + gPos.y * 0.09 - uGustPhase), 0.0), 2.0);
      gDir.x += sign(uWind + 1e-4) * gGust * uGustAmp * uSway;
      transformed.xz += gDir * gB;
      transformed.y -= dot(gDir, gDir) * gB * 0.5;
    }
  `;

  // 1株分の葉。blades 枚を放射状に配置し、葉ごとに高さと外側への反りを変える。
  // 高さ 1 に正規化し、葉の幅と反りは高さに対する比で与える（実寸はインスタンスの一様スケール）
  const BLADE_H = [1, 0.72, 0.88, 0.62, 0.95, 0.8, 0.7];
  const BLADE_LEAN = [0.6, 1, 0.8, 1.2, 0.7, 1.1, 0.9];
  function clumpGeometry(THREE, blades, segs, bladeWidth, spread) {
    const pos = [], nrm = [], col = [], idx = [];
    for (let b = 0; b < blades; b++) {
      const a = (b / blades) * Math.PI * 2 + b * 0.37;
      const ca = Math.cos(a), sa = Math.sin(a);
      const hf = BLADE_H[b % BLADE_H.length];
      const lean = spread * BLADE_LEAN[b % BLADE_LEAN.length];
      const base = pos.length / 3;
      for (let sgm = 0; sgm <= segs; sgm++) {
        const v = sgm / segs;
        const out = 0.03 + lean * v * v;                     // 外側への反り
        const half = 0.5 * bladeWidth * (1 - Math.pow(v, 1.5)); // 先端に向かって細くなる
        const shade = 0.4 + 0.6 * v;                          // 根元は暗く、先端ほど明るい
        for (let side = -1; side <= 1; side += 2) {
          pos.push(ca * out - sa * half * side, v * hf, sa * out + ca * half * side);
          nrm.push(ca, 0, sa);
          col.push(shade, shade, shade);
        }
      }
      for (let sgm = 0; sgm < segs; sgm++) {
        const i0 = base + sgm * 2;
        idx.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    return geo;
  }

  function makeGrass(THREE, scene, opts) {
    opts = opts || {};
    const count = Math.max(1, Math.floor(opts.count || 1000));
    const area = Object.assign({ x: [-15, 15], z: [-15, 15] }, opts.area);
    const place = typeof opts.place === 'function'
      ? opts.place
      : () => [
        area.x[0] + Math.random() * (area.x[1] - area.x[0]),
        area.z[0] + Math.random() * (area.z[1] - area.z[0]),
      ];
    const height = opts.height || [0.4, 1.0];
    const blades = opts.blades || 5;                                       // 1株の葉の枚数
    const bladeWidth = opts.bladeWidth !== undefined ? opts.bladeWidth : 0.06; // 葉の幅（高さに対する比）
    const spread = opts.spread !== undefined ? opts.spread : 0.3;          // 外側への反り（高さに対する比）
    const color = opts.color !== undefined ? opts.color : 0x4c6b3a;
    const tint = opts.tint !== undefined ? opts.tint : 0.3; // 株ごとの明るさのばらつき
    const roughness = opts.roughness !== undefined ? opts.roughness : 0.85;

    // clusters = { count, radius, ratio }：株の ratio 割を count 個の中心のまわりに集めて群生させる
    let placer = place;
    if (opts.clusters) {
      const cc = Math.max(1, Math.floor(opts.clusters.count || 40));
      const radius = opts.clusters.radius !== undefined ? opts.clusters.radius : 1.5;
      const ratio = opts.clusters.ratio !== undefined ? opts.clusters.ratio : 0.7;
      const centers = [];
      for (let i = 0; i < cc; i++) centers.push(place(i));
      placer = (i) => {
        if (Math.random() >= ratio) return place(i);
        const c = centers[Math.floor(Math.random() * cc)];
        return [
          c[0] + radius * (Math.random() + Math.random() - 1),
          c[1] + radius * (Math.random() + Math.random() - 1),
        ];
      };
    }

    const uniforms = { uTime: { value: 0 }, uWind: { value: 0 }, uSway: { value: 1 }, uGustPhase: { value: 0 }, uGustAmp: { value: 0 } };
    const mat = new THREE.MeshStandardMaterial({
      color, roughness, metalness: 0, side: THREE.DoubleSide, vertexColors: true,
    });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = GRASS_PREFIX + shader.vertexShader
        .replace('#include <beginnormal_vertex>', GRASS_NORMAL)
        .replace('#include <begin_vertex>', GRASS_BEND);
    };
    mat.customProgramCacheKey = () => 'madobe-grass';

    const mesh = new THREE.InstancedMesh(clumpGeometry(THREE, blades, 5, bladeWidth, spread), mat, count);
    mesh.frustumCulled = false;
    mesh.receiveShadow = opts.receiveShadow !== false;
    const m = new THREE.Matrix4();
    const pv = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sv = new THREE.Vector3();
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const xz = placer(i); // [x, z] または [x, z, y]（起伏のある地面に置くとき）
      const h = height[0] + Math.random() * (height[1] - height[0]);
      pv.set(xz[0], xz.length > 2 ? xz[2] : 0, xz[1]);
      sv.set(h, h, h);
      mesh.setMatrixAt(i, m.compose(pv, q, sv));
      const k = 1 - tint / 2 + Math.random() * tint;
      c.setRGB(k, k * (1 - tint * 0.15 + Math.random() * tint * 0.3), k);
      mesh.setColorAt(i, c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);

    // p = { wind, sway, gustPhase, gustAmp }。wind はシーンの風パラメータ、sway は揺れの強さ（0 で静止、既定 1）、
    // gustPhase / gustAmp は草原を渡る突風の波の位相（風速の積分など）と強さ（既定 0 = なし）
    function update(dt, t, p) {
      p = p || {};
      uniforms.uTime.value = t;
      uniforms.uWind.value = p.wind || 0;
      uniforms.uSway.value = p.sway !== undefined ? p.sway : 1;
      uniforms.uGustPhase.value = p.gustPhase || 0;
      uniforms.uGustAmp.value = p.gustAmp || 0;
    }

    return { mesh, material: mat, update };
  }

  /**
   * 1/f ゆらぎ（ピンクノイズ）の時間関数。
   * 周波数が 2 倍ずつ違う「なめらかな値ノイズ」を octaves 本重ねる。各オクターブの振幅を
   * 2^(-k(β-1)/2) にするとパワースペクトルが 1/f^β になる：β=0 で白色（せわしない）、
   * β=1 で 1/f（自然なゆらぎ）、β=2 でブラウン（ゆったり）。sample(t, beta) は概ね -1〜1 を返す。
   * 風の強さ・炎の明滅・光のちらつきなど、「一定でも乱雑でもない」変化を付けたいときに使う。
   */
  function makeFluctuation(opts) {
    opts = opts || {};
    const octaves = Math.max(1, Math.floor(opts.octaves || 8));
    const baseFreq = opts.baseFreq || 1 / 32; // 最も遅いオクターブの周波数（Hz）。既定は周期 32 秒
    const size = 256;                           // 格子の長さ（周期的に繰り返す）
    const lattices = [];
    for (let k = 0; k < octaves; k++) {
      const l = new Float32Array(size);
      for (let i = 0; i < size; i++) l[i] = Math.random() * 2 - 1;
      lattices.push(l);
    }
    const amps = new Float32Array(octaves);
    let lastBeta = null;
    let norm = 1;
    function setBeta(beta) {
      lastBeta = beta;
      let sum = 0;
      for (let k = 0; k < octaves; k++) {
        amps[k] = Math.pow(2, -k * (beta - 1) / 2);
        sum += amps[k] * amps[k];
      }
      norm = 1.35 / Math.sqrt(sum); // 実効値がおよそ 0.5 になるよう正規化
    }
    // 格子の値を 3 次のスムーズステップで補間（速いオクターブでも角ばらない）
    function smooth(l, x) {
      const i = Math.floor(x);
      let f = x - i;
      f = f * f * (3 - 2 * f);
      const a = l[((i % size) + size) % size];
      const b = l[(((i + 1) % size) + size) % size];
      return a + (b - a) * f;
    }
    function sample(t, beta) {
      if (beta === undefined) beta = 1;
      if (beta !== lastBeta) setBeta(beta);
      let v = 0;
      let f = baseFreq;
      for (let k = 0; k < octaves; k++) {
        v += amps[k] * smooth(lattices[k], t * f + k * 37.1);
        f *= 2;
      }
      return Math.max(-1, Math.min(1, v * norm));
    }
    return { sample, octaves, baseFreq };
  }

  /**
   * ゆらゆら揺れる炎。細長い板を layers 枚、カメラの方を向けて少しずつ角度をずらして重ねる。
   * 形と色はフラグメントシェーダーで作る：起動時に生成したノイズテクスチャを上向きに流し、大きなうねりで
   * 全体をしならせ、輪郭をなだらかにぼかしつつ、温度に応じた黒体放射風の色（暗赤→橙→黄→白）を付ける。
   * 画像ファイルは不要。加算合成で HDR 値を出すので、makePost のブルームと組み合わせると芯が発光する。
   * embers を指定すると根元から舞い上がる火の粉、smoke を指定すると先端から立ちのぼる煙が付く。
   * update が返す flicker（およそ 0.8〜1.2）を光源の強さに掛けると、光も炎と同じ拍で明滅する。
   */
  const NOISE_GLSL = `
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
    float snoise(vec3 v) {
      const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      i = mod289(i);
      vec4 p = permute(permute(permute(
        i.z + vec4(0.0, i1.z, i2.z, 1.0))
        + i.y + vec4(0.0, i1.y, i2.y, 1.0))
        + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0) * 2.0 + 1.0;
      vec4 s1 = floor(b1) * 2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
    }
    float fbm(vec3 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 5; i++) {
        v += a * snoise(p);
        p = p * 2.02 + vec3(3.1, 1.7, 0.9);
        a *= 0.5;
      }
      return v;
    }
    float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x),
        mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x),
        f.y);
    }
  `;
  const FLAME_VERT = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const FLAME_FRAG = `
    uniform sampler2D uNoise;
    uniform float uTime;
    uniform float uWind;
    uniform float uPower;
    uniform float uSeed;
    uniform float uAlpha;
    uniform float uBright;
    uniform float uSpan;
    varying vec2 vUv;

    void main() {
      float y = vUv.y;                           // 0 = 根元, 1 = 先端
      float qx = vUv.x * 2.0 - 1.0;              // 板の中での位置 -1 .. 1
      float x = qx * uSpan;                      // 炎の基準の半幅を 1 とした位置（板は炎より広い）
      // 風で先端ほど流される
      x -= uWind * 0.3 * y * y;
      vec2 so = vec2(uSeed * 0.37, uSeed * 0.61);
      // 大きくゆっくりしたうねり：炎全体が左右にしなり、先端ほど大きく振れる
      vec2 sway = texture2D(uNoise, vec2(x * 0.07, y * 0.16 - uTime * 0.13) + so).rg - 0.5;
      x += sway.x * (0.2 + 1.4 * y);
      float yy = y + sway.y * 0.35 * y;
      // 上向きに流れる 2 層のノイズ。速さと細かさを変えて重ね、舌のように伸びる形を作る
      float n1 = texture2D(uNoise, vec2(x * 0.13, yy * 0.26 - uTime * 0.36) + so.yx).b;
      float n2 = texture2D(uNoise, vec2(x * 0.27, yy * 0.5 - uTime * 0.6) - so).a;
      float n = n1 * 0.62 + n2 * 0.38;           // 0 .. 1
      // 先端に向かって細くなる幅。根元は少し絞り、n1 で太さも揺らす
      float w = pow(max(1.0 - y, 0.0), 0.6) * (0.66 + 0.5 * n1) * mix(0.55, 1.0, smoothstep(0.0, 0.25, y));
      // 輪郭からの距離（内側が正）。上へ行くほどノイズで大きく削り、先端を千切る
      float e = w - abs(x) + (n - 0.5) * (0.2 + 1.2 * y) - 0.06 * y;
      // 輪郭は幅を持たせてなだらかに立ち上げる（硬い縁を作らない）
      float v = smoothstep(-0.08, 0.3, e);
      v *= smoothstep(0.0, 0.14, y);                           // 根元をぼかす
      v *= 1.0 - smoothstep(0.82, 1.0, y);                     // 板の上端で切れないように
      v *= 1.0 - smoothstep(0.75, 1.0, abs(qx));               // 板の左右端で切れないように
      v *= 0.85 + 0.15 * uPower;
      // 温度：輪郭から深く、根元に近いほど高い → 黒体放射風の色
      // 細かい縦の筋を温度にだけ乗せて、内側に流れる濃淡を作る（輪郭は荒らさない）
      float n3 = texture2D(uNoise, vec2(x * 0.5, yy * 0.42 - uTime * 0.85) + so * 1.7).r;
      float T = clamp(smoothstep(-0.02, 0.55, e) * (1.05 - y * 0.6) * smoothstep(0.0, 0.25, y) * (0.72 + 0.56 * n3), 0.0, 1.0);
      vec3 col = mix(vec3(0.45, 0.03, 0.0), vec3(1.0, 0.27, 0.02), smoothstep(0.0, 0.3, T));
      col = mix(col, vec3(1.0, 0.62, 0.12), smoothstep(0.25, 0.6, T));
      col = mix(col, vec3(1.0, 0.9, 0.6), smoothstep(0.6, 1.0, T));
      float hdr = uBright * (0.45 + 1.6 * T * T);
      gl_FragColor = vec4(col * hdr, v * uAlpha);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }
  `;
  const FLAME_SPAN = 2.2; // 板の半幅 ÷ 炎の基準の半幅。うねりや風で流れても板の端で切れない余白

  // 炎用のノイズテクスチャ。継ぎ目なく繰り返す値ノイズの fBm を RGBA に 4 種類入れる。
  // シェーダーで毎ピクセル計算する代わりに引くだけなので軽く、線形補間で縁もなめらかになる
  function makeFlameNoise(THREE) {
    const N = 256;
    const data = new Uint8Array(N * N * 4);
    const acc = new Float32Array(N * N);
    for (let ch = 0; ch < 4; ch++) {
      acc.fill(0);
      let amp = 0.5;
      for (let cells = 4; cells <= 32; cells *= 2) {
        const lat = new Float32Array(cells * cells);
        for (let i = 0; i < lat.length; i++) lat[i] = Math.random();
        for (let py = 0; py < N; py++) {
          const gy = (py / N) * cells;
          const y0 = Math.floor(gy);
          let fy = gy - y0;
          fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
          const r0 = (y0 % cells) * cells, r1 = ((y0 + 1) % cells) * cells;
          for (let px = 0; px < N; px++) {
            const gx = (px / N) * cells;
            const x0 = Math.floor(gx);
            let fx = gx - x0;
            fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
            const c0 = x0 % cells, c1 = (x0 + 1) % cells;
            const top = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * fx;
            const bot = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * fx;
            acc[py * N + px] += (top + (bot - top) * fy) * amp;
          }
        }
        amp *= 0.5;
      }
      // 0〜1 いっぱいに引き伸ばす
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < acc.length; i++) { if (acc[i] < lo) lo = acc[i]; if (acc[i] > hi) hi = acc[i]; }
      for (let i = 0; i < acc.length; i++) data[i * 4 + ch] = Math.round(((acc[i] - lo) / (hi - lo)) * 255);
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }
  const EMBER_VERT = `
    attribute float aLife;
    attribute float aSize;
    uniform float uScale;
    varying float vLife;
    void main() {
      vLife = aLife;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
      gl_Position = projectionMatrix * mv;
    }
  `;
  const EMBER_FRAG = `
    varying float vLife;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float d = length(c) * 2.0;
      float a = 1.0 - smoothstep(0.15, 1.0, d);
      float fade = smoothstep(0.0, 0.08, vLife) * (1.0 - smoothstep(0.55, 1.0, vLife));
      vec3 col = mix(vec3(1.0, 0.86, 0.5), vec3(1.0, 0.3, 0.04), smoothstep(0.1, 0.8, vLife));
      gl_FragColor = vec4(col * 2.5, a * fade);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }
  `;
  const SMOKE_VERT = `
    attribute float aLife;
    attribute float aSize;
    attribute float aSeed;
    uniform float uScale;
    varying float vLife;
    varying float vSeed;
    void main() {
      vLife = aLife;
      vSeed = aSeed;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (0.5 + aLife * 2.5) * uScale / max(-mv.z, 0.1);
      gl_Position = projectionMatrix * mv;
    }
  `;
  const SMOKE_FRAG = NOISE_GLSL + `
    uniform vec3 uTint;
    uniform float uOpacity;
    varying float vLife;
    varying float vSeed;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float d = length(c) * 2.0;
      if (d > 1.0) discard;
      // 粒の中をノイズでまだらにして、重なったときに筋雲のように見せる
      float n = vnoise(gl_PointCoord * 3.0 + vSeed * 10.0 + vLife * 1.5) * 0.7
              + vnoise(gl_PointCoord * 7.0 + vSeed * 5.0) * 0.3;
      float a = (1.0 - smoothstep(0.2, 1.0, d)) * (0.45 + 0.9 * n);
      float fade = smoothstep(0.0, 0.12, vLife) * (1.0 - smoothstep(0.35, 1.0, vLife));
      // 出たては炎に照らされて暖色、上るにつれて灰色に
      vec3 col = mix(uTint, vec3(0.16, 0.15, 0.15), smoothstep(0.0, 0.5, vLife));
      gl_FragColor = vec4(col, a * fade * uOpacity);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }
  `;

  function makeFlame(THREE, scene, opts) {
    opts = opts || {};
    const layers = Math.max(1, Math.floor(opts.layers || 4));
    const width = opts.width !== undefined ? opts.width : 0.9;
    const height = opts.height !== undefined ? opts.height : 1.6;
    const camera = opts.camera || null;
    const seed = opts.seed !== undefined ? opts.seed : Math.random() * 100;
    const bright = opts.bright !== undefined ? opts.bright : 1.6;

    const group = new THREE.Group();
    if (opts.position) group.position.copy(opts.position);
    scene.add(group);

    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    geo.translate(0, 0.5, 0); // 根元を原点に
    const noiseTex = makeFlameNoise(THREE);
    const uniformsList = [];
    const meshes = [];
    for (let i = 0; i < layers; i++) {
      const uniforms = {
        uTime: { value: 0 },
        uWind: { value: 0 },
        uPower: { value: 1 },
        uSeed: { value: seed + i * 7.3 },
        uAlpha: { value: (i === 0 ? 1.0 : 0.8) / Math.sqrt(layers) },
        uBright: { value: bright * (i === 0 ? 1.2 : 1) },
        uSpan: { value: FLAME_SPAN },
        uNoise: { value: noiseTex },
      };
      const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: FLAME_VERT,
        fragmentShader: FLAME_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      // 正面向きを基本に、少しずつ角度をずらして奥行きを出す
      mesh.rotation.y = (i - (layers - 1) / 2) * 0.35;
      mesh.frustumCulled = false;
      group.add(mesh);
      uniformsList.push(uniforms);
      meshes.push(mesh);
    }

    // ---- 粒子の共通部品（火の粉・煙）----
    function makeParticles(max, shader, blending, extraAttrs) {
      const pos = new Float32Array(max * 3);
      const life = new Float32Array(max);
      const size = new Float32Array(max);
      const geo = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(pos, 3);
      const lifeAttr = new THREE.BufferAttribute(life, 1);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      lifeAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', posAttr);
      geo.setAttribute('aLife', lifeAttr);
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      if (extraAttrs) Object.keys(extraAttrs).forEach((k) => geo.setAttribute(k, new THREE.BufferAttribute(extraAttrs[k], 1)));
      const mat = new THREE.ShaderMaterial({
        uniforms: Object.assign({ uScale: { value: 300 } }, shader.uniforms),
        vertexShader: shader.vert,
        fragmentShader: shader.frag,
        transparent: true,
        depthWrite: false,
        blending,
      });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      group.add(points);
      return { pos, life, size, posAttr, lifeAttr, geo, mat, points, max, drawn: -1 };
    }

    // ---- 火の粉 ----
    let embers = null;
    if (opts.embers) {
      const max = Math.max(1, Math.floor(opts.embers.max || 200));
      const P = makeParticles(max, { vert: EMBER_VERT, frag: EMBER_FRAG }, THREE.AdditiveBlending);
      const { pos, life, size } = P;
      const vx = new Float32Array(max), vy = new Float32Array(max), vz = new Float32Array(max);
      const span = new Float32Array(max);
      const ph = new Float32Array(max);
      const spawn = (i, power) => {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * width * 0.3;
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = Math.random() * height * 0.25;
        pos[i * 3 + 2] = Math.sin(a) * r;
        vx[i] = (Math.random() - 0.5) * 0.4;
        vz[i] = (Math.random() - 0.5) * 0.4;
        vy[i] = (1.0 + Math.random() * 1.5) * (0.6 + power * 0.4);
        span[i] = 1.2 + Math.random() * 1.8;
        size[i] = 0.05 + Math.random() * 0.07;
        ph[i] = Math.random() * Math.PI * 2;
      };
      for (let i = 0; i < max; i++) {
        spawn(i, 1);
        life[i] = Math.random(); // 最初からばらけさせる
      }
      embers = {
        points: P.points,
        update(dt, t, count, wind, power) {
          count = Math.max(0, Math.min(max, Math.floor(count)));
          for (let i = 0; i < count; i++) {
            life[i] += dt / span[i];
            if (life[i] >= 1) { spawn(i, power); life[i] = 0; }
            // 風に流され、上昇はゆっくり弱まり、左右にふらつく
            vx[i] += (wind * 0.8 - vx[i]) * dt * 0.9 + Math.sin(t * 3.1 + ph[i]) * dt * 1.2;
            vz[i] += (0 - vz[i]) * dt * 0.9 + Math.cos(t * 2.7 + ph[i] * 1.3) * dt * 1.2;
            vy[i] += (0.5 - vy[i]) * dt * 0.5;
            pos[i * 3] += vx[i] * dt;
            pos[i * 3 + 1] += vy[i] * dt;
            pos[i * 3 + 2] += vz[i] * dt;
          }
          P.posAttr.needsUpdate = true;
          P.lifeAttr.needsUpdate = true;
          if (P.drawn !== count) { P.geo.setDrawRange(0, count); P.drawn = count; }
        },
        setScale(v) { P.mat.uniforms.uScale.value = v; },
      };
    }

    // ---- 煙 ----
    let smoke = null;
    if (opts.smoke) {
      const max = Math.max(1, Math.floor(opts.smoke.max || 120));
      const seeds = new Float32Array(max);
      for (let i = 0; i < max; i++) seeds[i] = Math.random();
      const P = makeParticles(max, {
        vert: SMOKE_VERT,
        frag: SMOKE_FRAG,
        uniforms: {
          uTint: { value: new THREE.Color(opts.smoke.tint !== undefined ? opts.smoke.tint : 0x8c4a22) },
          uOpacity: { value: opts.smoke.opacity !== undefined ? opts.smoke.opacity : 0.22 },
        },
      }, THREE.NormalBlending, { aSeed: seeds });
      P.points.renderOrder = 2; // 炎より後に描いて、先端を煙で隠す
      const { pos, life, size } = P;
      const vx = new Float32Array(max), vy = new Float32Array(max), vz = new Float32Array(max);
      const span = new Float32Array(max);
      const ph = new Float32Array(max);
      const spawn = (i, power) => {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * width * 0.25;
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = height * (0.45 + Math.random() * 0.3) * Math.pow(power, 0.6);
        pos[i * 3 + 2] = Math.sin(a) * r;
        vx[i] = (Math.random() - 0.5) * 0.3;
        vz[i] = (Math.random() - 0.5) * 0.3;
        vy[i] = 0.7 + Math.random() * 0.6;
        span[i] = 3 + Math.random() * 2.5;
        size[i] = (0.35 + Math.random() * 0.3) * (0.7 + power * 0.3);
        ph[i] = Math.random() * Math.PI * 2;
      };
      for (let i = 0; i < max; i++) {
        spawn(i, 1);
        life[i] = Math.random();
      }
      smoke = {
        points: P.points,
        update(dt, t, count, wind, power) {
          count = Math.max(0, Math.min(max, Math.floor(count)));
          for (let i = 0; i < count; i++) {
            life[i] += dt / span[i];
            if (life[i] >= 1) { spawn(i, power); life[i] = 0; }
            vx[i] += (wind * 0.9 - vx[i]) * dt * 0.6 + Math.sin(t * 1.3 + ph[i]) * dt * 0.5;
            vz[i] += (0 - vz[i]) * dt * 0.6 + Math.cos(t * 1.1 + ph[i] * 1.7) * dt * 0.5;
            vy[i] += (0.45 - vy[i]) * dt * 0.4;
            pos[i * 3] += vx[i] * dt;
            pos[i * 3 + 1] += vy[i] * dt;
            pos[i * 3 + 2] += vz[i] * dt;
          }
          P.posAttr.needsUpdate = true;
          P.lifeAttr.needsUpdate = true;
          if (P.drawn !== count) { P.geo.setDrawRange(0, count); P.drawn = count; }
        },
        setScale(v) { P.mat.uniforms.uScale.value = v; },
      };
    }

    const flicker = { value: 1 };
    const flickerNoise = makeFluctuation({ octaves: 7, baseFreq: 1 / 8 });

    // p = { power, wind, embers, smoke, pixelHeight }
    //   power は火の勢い（1 が基準）、wind は風、embers / smoke は粒の表示数、
    //   pixelHeight は描画バッファの高さ（粒の大きさを画面サイズに合わせる。省略時は 600）
    function update(dt, t, p) {
      p = p || {};
      const power = p.power !== undefined ? p.power : 1;
      const wind = p.wind || 0;
      // 炎の拍：1/f ゆらぎで、せわしなくも単調でもない明滅にする
      flicker.value = 1 + flickerNoise.sample(t, 1.2) * 0.2;
      const h = height * Math.pow(power, 0.6) * (0.92 + flicker.value * 0.08);
      const w = width * Math.pow(power, 0.35);
      if (camera) group.rotation.y = Math.atan2(camera.position.x - group.position.x, camera.position.z - group.position.z);
      for (let i = 0; i < layers; i++) {
        const u = uniformsList[i];
        u.uTime.value = t * (0.9 + i * 0.12);
        u.uWind.value = wind;
        u.uPower.value = power;
        const k = i === 0 ? 0.6 : 1 - (i - 1) * (0.35 / layers);
        meshes[i].scale.set(w * k * FLAME_SPAN, h * (i === 0 ? 0.85 : 1 - (i - 1) * 0.06), 1);
      }
      const scale = (p.pixelHeight || 600) * 0.5;
      if (embers) {
        embers.setScale(scale);
        embers.update(dt, t, p.embers !== undefined ? p.embers : 0, wind, power);
      }
      if (smoke) {
        smoke.setScale(scale);
        smoke.update(dt, t, p.smoke !== undefined ? p.smoke : 0, wind, power);
      }
    }

    return { group, flicker, update, embers, smoke };
  }

  /**
   * 流体シミュレーションで動かす炎。小さな格子（既定 160×240）の上で 2 次元の流体を GPU で解き、
   * 「燃料」と「熱」を流れに乗せて運ぶ。熱い気体は浮力で加速しながら昇り、まわりの空気を巻き込んで
   * くびれ、渦でちぎれる——炎の形と動きはこの計算から出てくる（ノイズを流すだけの炎と違い、
   * 同じ形が二度と出ない）。結果を 1 枚の板に加算合成で映す。火の粉（残像つきの筋）と煙も付く。
   *
   * 1 ステップ（1/60 秒）の流れ：渦度 → 速度の移流と外力（浮力・風・渦の補強・乱れ）→ 燃料と熱の移流と燃焼
   * → 発散 → 圧力（ヤコビ法）→ 圧力勾配を引いて非圧縮に。半精度浮動小数のレンダーターゲットが要るので、
   * 使えない環境では makeFlame（ノイズの炎）に自動で切り替える。
   */
  const SIM_CURL_FRAG = `
    uniform sampler2D tVel;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      float l = texture2D(tVel, vUv - vec2(uTexel.x, 0.0)).y;
      float r = texture2D(tVel, vUv + vec2(uTexel.x, 0.0)).y;
      float b = texture2D(tVel, vUv - vec2(0.0, uTexel.y)).x;
      float t = texture2D(tVel, vUv + vec2(0.0, uTexel.y)).x;
      gl_FragColor = vec4((r - l) - (t - b), 0.0, 0.0, 1.0);
    }
  `;
  const SIM_VEL_FRAG = `
    uniform sampler2D tVel;
    uniform sampler2D tScl;
    uniform sampler2D tCurl;
    uniform sampler2D tNoise;
    uniform vec2 uTexel;
    uniform vec2 uSize;
    uniform float uDt;
    uniform float uTime;
    uniform float uBuoy;
    uniform float uWind;
    uniform float uVort;
    uniform float uTurb;
    uniform float uDamp;
    varying vec2 vUv;
    void main() {
      // 移流：自分の速度ぶんだけ過去の位置から値を持ってくる（無条件安定）
      vec2 v0 = texture2D(tVel, vUv).xy;
      vec2 p = vUv - uDt * v0 / uSize;
      vec2 v = texture2D(tVel, p).xy;
      // 隣との平均をわずかに混ぜる：格子 1 目ごとに符号が反転するギザギザ（市松模様の不安定）を抑える
      vec2 ex = vec2(uTexel.x, 0.0);
      vec2 ey = vec2(0.0, uTexel.y);
      vec2 avg = 0.25 * (texture2D(tVel, p + ex).xy + texture2D(tVel, p - ex).xy + texture2D(tVel, p + ey).xy + texture2D(tVel, p - ey).xy);
      v = mix(v, avg, 0.22);
      v /= 1.0 + uDamp * uDt;
      float heat = texture2D(tScl, vUv).g;
      // 浮力：熱い気体ほど強く上へ加速する
      v.y += uDt * uBuoy * heat;
      // 風：空気全体が横風の速さへゆっくり近づく（地面の近くは弱い）
      float hgt = vUv.y * uSize.y;
      v.x += (uWind * smoothstep(0.0, 0.6, hgt) - v.x) * (1.0 - exp(-uDt * (0.25 + 0.5 * abs(uWind))));
      // 渦の補強：数値拡散で消えていく小さな渦を、渦度の勾配に直交する力で補う
      vec2 dx = vec2(uTexel.x, 0.0);
      vec2 dy = vec2(0.0, uTexel.y);
      float c = texture2D(tCurl, vUv).x;
      vec2 g = vec2(
        abs(texture2D(tCurl, vUv + dx).x) - abs(texture2D(tCurl, vUv - dx).x),
        abs(texture2D(tCurl, vUv + dy).x) - abs(texture2D(tCurl, vUv - dy).x));
      g /= length(g) + 1e-3;
      v += uDt * uVort * vec2(g.y, -g.x) * c;
      // 乱れ：熱いところだけ、流れるノイズで小さく揺する（炎の縁を割る種になる）
      vec2 n = texture2D(tNoise, vUv * vec2(1.7, 2.3) + vec2(uTime * 0.11, -uTime * 0.53)).rg
             + texture2D(tNoise, vUv * vec2(4.1, 5.3) + vec2(-uTime * 0.23, -uTime * 1.1)).ba - 1.0;
      v += uDt * uTurb * n * heat;
      // 地面：下向きには抜けない
      if (vUv.y < uTexel.y * 1.5) v = vec2(v.x * 0.8, 0.0);
      v = clamp(v, vec2(-8.0), vec2(8.0));
      gl_FragColor = vec4(v, 0.0, 1.0);
    }
  `;
  const SIM_EMITTERS = 8;
  const SIM_SCL_FRAG = `
    uniform sampler2D tVel;
    uniform sampler2D tScl;
    uniform sampler2D tNoise;
    uniform vec2 uSize;
    uniform float uDt;
    uniform float uTime;
    uniform float uBurn;
    uniform float uCool;
    uniform vec4 uSeg[${SIM_EMITTERS}];    // 火元の線分：x1, y1, x2, y2（m）
    uniform vec4 uSegP[${SIM_EMITTERS}];   // 半径（m）, 強さ, 種, 未使用
    varying vec2 vUv;
    void main() {
      vec2 v = texture2D(tVel, vUv).xy;
      vec4 s = texture2D(tScl, vUv - uDt * v / uSize);
      float fuel = s.r;   // 燃料：火元で 1、燃えながら昇って減っていく（光るのはここ）
      float heat = s.g;   // 熱：浮力のもと。燃料が尽きても少し残り、見えない熱気として昇る
      float burn = min(fuel, fuel * (1.0 - exp(-uBurn * uDt)) + 0.3 * uDt);
      fuel -= burn;
      heat = heat * exp(-uCool * uDt) + burn * 0.6;
      // 火元：薪の上面や熾に沿って置いた線分。線に沿った位置ごとに強さが移ろい、炎の舌が立っては消える
      vec2 pos = vec2((vUv.x - 0.5) * uSize.x, vUv.y * uSize.y);
      float src = 0.0;
      for (int i = 0; i < ${SIM_EMITTERS}; i++) {
        vec2 a = uSeg[i].xy;
        vec2 ba = uSeg[i].zw - a;
        vec2 pa = pos - a;
        float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
        vec2 d = pa - ba * h;
        vec4 q = uSegP[i];
        float g = exp(-dot(d, d) / max(q.x * q.x, 1e-6));
        float nz = texture2D(tNoise, vec2(h * length(ba) * 2.6 + q.z, uTime * 0.55 + q.z * 3.7)).r;
        src = max(src, q.y * g * (0.05 + 1.1 * smoothstep(0.3, 0.72, nz)));
      }
      float n = texture2D(tNoise, pos * vec2(2.9, 2.3) + vec2(uTime * 0.41, -uTime * 1.9)).g;
      src *= 0.5 + 1.0 * n;
      src = min(src, 1.0);
      fuel = max(fuel, src);
      heat = min(max(heat, src * 0.85), 1.3);
      // 端：外へ出たものは消す（開いた境界）
      float edge = smoothstep(0.0, 0.05, vUv.x) * smoothstep(0.0, 0.05, 1.0 - vUv.x) * smoothstep(0.0, 0.08, 1.0 - vUv.y);
      gl_FragColor = vec4(fuel * edge, heat * edge, burn / uDt, 1.0);
    }
  `;
  const SIM_DIV_FRAG = `
    uniform sampler2D tVel;
    uniform sampler2D tScl;
    uniform vec2 uTexel;
    uniform float uExpand;
    varying vec2 vUv;
    void main() {
      float l = texture2D(tVel, vUv - vec2(uTexel.x, 0.0)).x;
      float r = texture2D(tVel, vUv + vec2(uTexel.x, 0.0)).x;
      float b = texture2D(tVel, vUv - vec2(0.0, uTexel.y)).y;
      float t = texture2D(tVel, vUv + vec2(0.0, uTexel.y)).y;
      // 燃えているところは気体が膨張する（わき出し）。炎が脈打つ原因のひとつ
      float d = 0.5 * ((r - l) + (t - b)) - uExpand * texture2D(tScl, vUv).b;
      gl_FragColor = vec4(d, 0.0, 0.0, 1.0);
    }
  `;
  // 境界：左右と上は開放（外の圧力 0）、下は地面（端の値を繰り返す＝勾配 0）
  const SIM_NEIGHBORS = `
      vec2 dx = vec2(uTexel.x, 0.0);
      vec2 dy = vec2(0.0, uTexel.y);
      float l = vUv.x - uTexel.x < 0.0 ? 0.0 : texture2D(tPrs, vUv - dx).x;
      float r = vUv.x + uTexel.x > 1.0 ? 0.0 : texture2D(tPrs, vUv + dx).x;
      float t = vUv.y + uTexel.y > 1.0 ? 0.0 : texture2D(tPrs, vUv + dy).x;
      float b = texture2D(tPrs, vUv - dy).x;
  `;
  const SIM_PRS_FRAG = `
    uniform sampler2D tPrs;
    uniform sampler2D tDiv;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      ${SIM_NEIGHBORS}
      gl_FragColor = vec4((l + r + b + t - texture2D(tDiv, vUv).x) * 0.25, 0.0, 0.0, 1.0);
    }
  `;
  const SIM_GRAD_FRAG = `
    uniform sampler2D tPrs;
    uniform sampler2D tVel;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      ${SIM_NEIGHBORS}
      vec2 v = texture2D(tVel, vUv).xy - 0.5 * vec2(r - l, t - b);
      if (vUv.y < uTexel.y * 1.5) v.y = 0.0;
      gl_FragColor = vec4(v, 0.0, 1.0);
    }
  `;
  // 表示：格子の値を双 3 次でなめらかに拡大し、燃料の量から明るさと色（黒体放射風）を決める
  const FIRE_FRAG = `
    uniform sampler2D tScl;
    uniform sampler2D tNoise;
    uniform vec2 uRes;
    uniform float uTime;
    uniform float uBright;
    uniform float uSeed;  // 細部のノイズをずらす種（板ごとに変える）
    varying vec2 vUv;
    vec4 bicubic(sampler2D tex, vec2 uv) {
      vec2 st = uv * uRes - 0.5;
      vec2 i = floor(st);
      vec2 f = st - i;
      vec2 f2 = f * f;
      vec2 f3 = f2 * f;
      vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
      vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
      vec2 w3 = f3 / 6.0;
      vec2 w2 = 1.0 - w0 - w1 - w3;
      vec2 g0 = w0 + w1;
      vec2 g1 = w2 + w3;
      vec2 p0 = (i - 0.5 + w1 / g0) / uRes;
      vec2 p1 = (i + 1.5 + w3 / g1) / uRes;
      return g0.y * (g0.x * texture2D(tex, vec2(p0.x, p0.y)) + g1.x * texture2D(tex, vec2(p1.x, p0.y)))
           + g1.y * (g0.x * texture2D(tex, vec2(p0.x, p1.y)) + g1.x * texture2D(tex, vec2(p1.x, p1.y)));
    }
    void main() {
      vec2 uv = vUv;
      // 格子では解けない細い筋：上へ流れる細かいノイズで読む位置をわずかにずらす
      vec2 w1 = texture2D(tNoise, vec2(uv.x * 3.1 + uSeed, uv.y * 2.1 - uTime * 0.9)).rg - 0.5;
      vec2 w2 = texture2D(tNoise, vec2(uv.x * 7.3 - uSeed, uv.y * 4.9 - uTime * 1.7)).ba - 0.5;
      float lift = smoothstep(0.02, 0.25, uv.y);
      uv += (w1 * 0.012 + w2 * 0.005) * lift;
      vec4 s = bicubic(tScl, uv);
      float fuel = s.r;
      // 炎の体：燃料が残っているところ。縁はなだらかに立ち上げる
      float body = smoothstep(0.1, 0.38, fuel);
      // 温度：燃料が多い（火元に近い・芯）ほど高い
      float T = clamp(pow(fuel, 0.75), 0.0, 1.0);
      vec3 col = mix(vec3(1.0, 0.17, 0.005), vec3(1.0, 0.26, 0.014), smoothstep(0.1, 0.35, T));
      col = mix(col, vec3(1.0, 0.46, 0.06), smoothstep(0.3, 0.62, T));
      col = mix(col, vec3(1.0, 0.72, 0.26), smoothstep(0.6, 1.0, T));
      // 火元のすぐ上は、まだ燃えていない気体で少し暗い（芯が抜けて見える）
      float core = 1.0 - 0.4 * smoothstep(0.82, 1.0, fuel);
      float hdr = uBright * body * (0.35 + 3.0 * T * T) * core;
      gl_FragColor = vec4(col * hdr, 1.0);
    }
  `;
  // 火の粉：1 粒を「頭」と「少し前の位置」を結ぶ細長い板で描き、残像（モーションブラー）の筋にする
  const SPARK_VERT = `
    attribute vec3 aPos;
    attribute vec3 aVel;
    attribute vec3 aInfo;   // x: 寿命 0..1, y: 粒の半径 (m), z: 種
    uniform vec2 uViewport;
    uniform float uShutter;
    uniform float uMinPx;
    varying vec2 vPx;
    varying float vLen;
    varying float vW;
    varying vec3 vInfo;
    varying float vGain;
    void main() {
      vec4 head = modelViewMatrix * vec4(aPos, 1.0);
      vec4 tail = modelViewMatrix * vec4(aPos - aVel * uShutter, 1.0);
      vec4 ch = projectionMatrix * head;
      vec4 ct = projectionMatrix * tail;
      vec2 hv = uViewport * 0.5;
      vec2 sh = ch.xy / ch.w * hv;
      vec2 st = ct.xy / max(ct.w, 1e-4) * hv;
      vec2 d = sh - st;
      float len = length(d);
      vec2 dir = len > 1e-3 ? d / len : vec2(0.0, 1.0);
      vec2 nrm = vec2(-dir.y, dir.x);
      // 太さ：実寸を画面に投影。細すぎる粒は下限の太さにして、そのぶん暗くする（遠くでもちらつかない）
      float wpx = aInfo.y * projectionMatrix[1][1] * hv.y / max(-head.z, 0.1);
      float w = max(wpx, uMinPx);
      vGain = clamp(wpx / w, 0.12, 1.0);
      float along = position.y * (len + 2.0 * w) - w;
      vec2 p = st + dir * along + nrm * position.x * w;
      vPx = vec2(position.x * w, along);
      vLen = len;
      vW = w;
      vInfo = aInfo;
      gl_Position = vec4(p / hv * ch.w, ch.z, ch.w);
    }
  `;
  const SPARK_FRAG = `
    uniform float uTime;
    varying vec2 vPx;
    varying float vLen;
    varying float vW;
    varying vec3 vInfo;
    varying float vGain;
    void main() {
      float y = clamp(vPx.y, 0.0, vLen);
      float d = length(vec2(vPx.x, vPx.y - y)) / vW;
      float a = 1.0 - smoothstep(0.25, 1.0, d);
      // 筋は頭が明るく、尾へ向かって淡くなる。長い筋ほど光が薄く伸びる
      float k = vLen > 0.5 ? y / vLen : 1.0;
      a *= mix(0.12, 1.0, k * k) * (2.0 * vW / (vLen + 2.0 * vW) * 0.75 + 0.25);
      float life = vInfo.x;
      // 冷めるにつれて 黄 → 橙 → 暗い赤。ときどき瞬く
      vec3 col = mix(vec3(1.0, 0.6, 0.22), vec3(1.0, 0.33, 0.05), smoothstep(0.0, 0.4, life));
      col = mix(col, vec3(0.75, 0.1, 0.01), smoothstep(0.4, 1.0, life));
      float glow = mix(5.5, 1.0, smoothstep(0.0, 0.85, life)) * smoothstep(0.0, 0.06, life) * (1.0 - smoothstep(0.8, 1.0, life));
      glow *= 0.72 + 0.28 * sin(uTime * (17.0 + vInfo.z * 23.0) + vInfo.z * 40.0);
      gl_FragColor = vec4(col * glow * vGain, a);
    }
  `;
  const FIRE_SMOKE_VERT = `
    attribute float aLife;
    attribute float aSize;
    attribute float aSeed;
    uniform float uScale;
    varying float vLife;
    varying float vSeed;
    varying float vH;
    void main() {
      vLife = aLife;
      vSeed = aSeed;
      vH = position.y;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (0.45 + aLife * 2.6) * uScale / max(-mv.z, 0.1);
      gl_Position = projectionMatrix * mv;
    }
  `;
  const FIRE_SMOKE_FRAG = `
    uniform sampler2D tNoise;
    uniform vec3 uLit;      // 炎に照らされた色（明滅込み）
    uniform vec3 uAmbient;  // 空の明るさだけを受けた色
    uniform float uOpacity;
    uniform float uTop;     // 炎の先端の高さ
    varying float vLife;
    varying float vSeed;
    varying float vH;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float d = length(c) * 2.0;
      if (d > 1.0) discard;
      // 粒ごとに向きと位置を変えたノイズで、綿のようなむらを付ける（縁は必ずなだらかに消す）
      float an = vSeed * 6.2831853;
      vec2 q = mat2(cos(an), -sin(an), sin(an), cos(an)) * c;
      vec4 n = texture2D(tNoise, q * 0.9 + vec2(vSeed * 7.0, vSeed * 3.0 + vLife * 0.2));
      float soft = 1.0 - smoothstep(0.0, 1.0, d);
      float a = soft * soft * (0.35 + 0.65 * smoothstep(0.2, 0.8, n.b * 0.6 + n.a * 0.4));
      float fade = smoothstep(0.0, 0.3, vLife) * (1.0 - smoothstep(0.35, 1.0, vLife));
      // 炎の光は距離の 2 乗で弱まる：先端のすぐ上だけほのかに染まり、上では夜空の色に沈む
      float h = max(vH - uTop * 0.7, 0.0);
      float lit = 1.0 / (1.0 + h * h * 3.5);
      vec3 col = uAmbient + uLit * lit * (0.5 + 0.5 * n.r);
      // 炎と重なる高さではほとんど見えない（炎の手前に暗い塊ができないように）。先端を抜けてから現れる
      float above = mix(0.12, 1.0, smoothstep(uTop * 0.75, uTop * 1.6, vH));
      gl_FragColor = vec4(col, a * fade * above * uOpacity);
    }
  `;

  function fireSimSupported(THREE, renderer) {
    if (!renderer || !renderer.capabilities || !renderer.capabilities.isWebGL2) return false;
    return renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  }

  function makeFire(THREE, renderer, scene, opts) {
    opts = opts || {};
    const width = opts.width !== undefined ? opts.width : 1.6;    // 計算する範囲の幅と高さ（m）
    const height = opts.height !== undefined ? opts.height : 2.4;
    const res = opts.res || [192, 288];
    const camera = opts.camera || null;
    const bright = opts.bright !== undefined ? opts.bright : 1.0;
    const simulated = opts.sim !== false && fireSimSupported(THREE, renderer);
    // 流体の調整値：浮力・渦の補強・乱れ・速度の減衰・燃える速さ・熱の冷める速さ・燃焼による膨張
    const tune = Object.assign({ buoy: 10, vort: 2.5, turb: 8.5, damp: 1.4, burn: 3.0, cool: 3.6, expand: 0.006 }, opts.tune);
    // 火元：線分 { x1, y1, x2, y2, r, w }。x は中心からの横位置、y は地面からの高さ、r は太さ（m）、w は強さ。
    // 板はカメラの方を向くので、薪の上面や熾の並びを「正面から見た形」で与える
    const emitters = (opts.emitters || [
      { x1: -0.24, y1: 0.1, x2: 0.24, y2: 0.1, r: 0.05, w: 0.9 },
      { x1: -0.2, y1: 0.16, x2: -0.02, y2: 0.4, r: 0.04, w: 1 },
      { x1: 0.2, y1: 0.16, x2: 0.03, y2: 0.42, r: 0.04, w: 1 },
      { x1: -0.08, y1: 0.2, x2: 0.1, y2: 0.3, r: 0.045, w: 1 },
    ]).slice(0, SIM_EMITTERS);

    const group = new THREE.Group();
    if (opts.position) group.position.copy(opts.position);
    scene.add(group);

    const noiseTex = makeFlameNoise(THREE);
    const flicker = { value: 1 };
    const flickerNoise = makeFluctuation({ octaves: 7, baseFreq: 1 / 8 });
    const emitNoise = makeFluctuation({ octaves: 6, baseFreq: 1 / 5 });
    const disposables = [noiseTex];

    // ---- 流体シミュレーション ----
    const sims = [];
    const planes = [];
    let stepSims = null; // (dt, power, wind) → 火元の強さの平均
    let fallback = null;
    if (simulated) {
      const rtOpts = {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      };
      const quadScene = new THREE.Scene();
      const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
      quad.frustumCulled = false;
      quadScene.add(quad);
      disposables.push(quad.geometry);
      const size = new THREE.Vector2(width, height);
      const pass = (mat, target) => {
        quad.material = mat;
        renderer.setRenderTarget(target);
        renderer.render(quadScene, quadCam);
      };
      const H = 1 / 60;

      // 流れを 1 つ解く。phase は火元のゆらぎをずらす量（別の流れは別の拍で揺れる）
      const makeSim = (nx, ny, iterations, phase) => {
        const mkRT = () => { const rt = new THREE.WebGLRenderTarget(nx, ny, rtOpts); disposables.push(rt); return rt; };
        let velA = mkRT(), velB = mkRT(), sclA = mkRT(), sclB = mkRT(), prsA = mkRT(), prsB = mkRT();
        const curlRT = mkRT(), divRT = mkRT();
        const texel = new THREE.Vector2(1 / nx, 1 / ny);
        const mk = (frag, uniforms) => {
          const m = new THREE.ShaderMaterial({ uniforms, vertexShader: POST_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, toneMapped: false });
          disposables.push(m);
          return m;
        };
        const segUniform = [], segPUniform = [];
        for (let i = 0; i < SIM_EMITTERS; i++) { segUniform.push(new THREE.Vector4()); segPUniform.push(new THREE.Vector4(0.01, 0, i * 0.37 + phase * 0.01, 0)); }
        const curlMat = mk(SIM_CURL_FRAG, { tVel: { value: null }, uTexel: { value: texel } });
        const velMat = mk(SIM_VEL_FRAG, {
          tVel: { value: null }, tScl: { value: null }, tCurl: { value: curlRT.texture }, tNoise: { value: noiseTex },
          uTexel: { value: texel }, uSize: { value: size }, uDt: { value: H }, uTime: { value: 0 },
          uBuoy: { value: tune.buoy }, uWind: { value: 0 }, uVort: { value: tune.vort }, uTurb: { value: tune.turb }, uDamp: { value: tune.damp },
        });
        const sclMat = mk(SIM_SCL_FRAG, {
          tVel: { value: null }, tScl: { value: null }, tNoise: { value: noiseTex },
          uSize: { value: size }, uDt: { value: H }, uTime: { value: 0 },
          uBurn: { value: tune.burn }, uCool: { value: tune.cool }, uSeg: { value: segUniform }, uSegP: { value: segPUniform },
        });
        const divMat = mk(SIM_DIV_FRAG, { tVel: { value: null }, tScl: { value: null }, uTexel: { value: texel }, uExpand: { value: tune.expand } });
        const prsMat = mk(SIM_PRS_FRAG, { tPrs: { value: null }, tDiv: { value: divRT.texture }, uTexel: { value: texel } });
        const gradMat = mk(SIM_GRAD_FRAG, { tPrs: { value: null }, tVel: { value: null }, uTexel: { value: texel } });
        let simTime = phase;
        const step = (power, wind) => {
          simTime += H;
          const pw = Math.pow(power, 0.5);
          // 火元の強さ：線分ごとに別々の 1/f ゆらぎ。火が弱いと外側から消え、強いと太く高くなる
          let sum = 0, wsum = 0;
          for (let i = 0; i < SIM_EMITTERS; i++) {
            const e = emitters[i];
            if (!e) { segPUniform[i].y = 0; continue; }
            const n = emitNoise.sample(simTime + i * 41.3, 1.1);
            const mx = Math.max(Math.abs(e.x1), Math.abs(e.x2));
            const reach = Math.max(0, Math.min(1, power * 1.8 + 0.36 - mx * 2.2));
            const st = Math.max(0, Math.min(1.3, (0.78 + 0.6 * n) * e.w * reach * (0.75 + 0.25 * power)));
            const k = 0.65 + 0.35 * pw;
            segUniform[i].set(e.x1 * k, e.y1, e.x2 * k, e.y1 + (e.y2 - e.y1) * (0.8 + 0.2 * pw));
            segPUniform[i].x = e.r * (0.6 + 0.4 * pw);
            segPUniform[i].y = st;
            sum += st * e.w; wsum += e.w;
          }
          velMat.uniforms.uTime.value = simTime;
          velMat.uniforms.uWind.value = wind * 0.3;
          sclMat.uniforms.uTime.value = simTime;
          sclMat.uniforms.uBurn.value = tune.burn / (0.45 + 0.55 * pw);

          curlMat.uniforms.tVel.value = velA.texture;
          pass(curlMat, curlRT);
          velMat.uniforms.tVel.value = velA.texture;
          velMat.uniforms.tScl.value = sclA.texture;
          pass(velMat, velB);
          let tmp = velA; velA = velB; velB = tmp;
          sclMat.uniforms.tVel.value = velA.texture;
          sclMat.uniforms.tScl.value = sclA.texture;
          pass(sclMat, sclB);
          tmp = sclA; sclA = sclB; sclB = tmp;
          divMat.uniforms.tVel.value = velA.texture;
          divMat.uniforms.tScl.value = sclA.texture;
          pass(divMat, divRT);
          for (let i = 0; i < iterations; i++) {
            prsMat.uniforms.tPrs.value = prsA.texture;
            pass(prsMat, prsB);
            tmp = prsA; prsA = prsB; prsB = tmp;
          }
          gradMat.uniforms.tPrs.value = prsA.texture;
          gradMat.uniforms.tVel.value = velA.texture;
          pass(gradMat, velB);
          tmp = velA; velA = velB; velB = tmp;
          return wsum > 0 ? sum / wsum : 0;
        };
        return { step, res: new THREE.Vector2(nx, ny), texture: () => sclA.texture, time: () => simTime };
      };

      // 表示用の板。根元の中心を原点にして、計算範囲と同じ大きさで立てる。
      // planes = [{ sim, x, z, scale, seed, bright }]：sim: 1 の板は 2 つ目の流れを映す。
      // 中心の炎の手前に、別の流れの小さめの炎を重ねると、薪を包む厚みが出る（同じ流れの写しだと形がそろって不自然）
      const planeDefs = opts.planes || [{}];
      sims.push(makeSim(res[0], res[1], opts.iterations || 22, 0));
      if (planeDefs.some((o) => o.sim === 1)) {
        sims.push(makeSim(Math.round(res[0] * 2 / 3), Math.round(res[1] * 2 / 3), Math.round((opts.iterations || 22) * 0.75), 137.5));
      }
      const planeGeo = new THREE.PlaneGeometry(width, height);
      planeGeo.translate(0, height / 2, 0);
      planeDefs.forEach((o) => {
        const sm = sims[o.sim === 1 ? 1 : 0];
        const uniforms = {
          tScl: { value: null }, tNoise: { value: noiseTex }, uRes: { value: sm.res },
          uTime: { value: 0 }, uBright: { value: bright * (o.bright !== undefined ? o.bright : 1) },
          uSeed: { value: o.seed || 0 },
        };
        const mat = new THREE.ShaderMaterial({
          uniforms, vertexShader: FLAME_VERT, fragmentShader: FIRE_FRAG,
          transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
        });
        const mesh = new THREE.Mesh(planeGeo, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 1;
        const sc = o.scale !== undefined ? o.scale : 1;
        mesh.scale.set(sc, sc, 1);
        mesh.position.set(o.x || 0, 0, o.z || 0);
        group.add(mesh);
        planes.push({ mesh, uniforms, sim: sm });
      });

      let acc = 0;
      let level = 0.6; // 火元の強さの平均（なめらかにしたもの）。光の明滅に使う
      stepSims = (dt, power, wind) => {
        acc += dt;
        let n = 0;
        const prev = renderer.getRenderTarget();
        while (acc >= H && n < 3) {
          let l = 0;
          for (let i = 0; i < sims.length; i++) l += sims[i].step(power, wind) * (i === 0 ? 1 : 0.5);
          level += (l / (1 + 0.5 * (sims.length - 1)) - level) * 0.12;
          acc -= H;
          n++;
        }
        if (acc >= H) acc = 0;
        if (n > 0) renderer.setRenderTarget(prev);
        for (let i = 0; i < planes.length; i++) {
          planes[i].uniforms.tScl.value = planes[i].sim.texture();
          planes[i].uniforms.uTime.value = planes[i].sim.time();
        }
        return level;
      };
    } else {
      // 浮動小数のレンダーターゲットが使えない環境：ノイズの炎で代用する
      fallback = makeFlame(THREE, scene, {
        layers: 4, width: 0.75, height: 1.6, bright: bright * 0.75, position: opts.position, camera,
      });
    }

    // 炎のまわりの空気の速さ（火の粉と煙を運ぶ）。軸に近いほど速い上昇気流＋横風＋ゆらぎ
    const air = { x: 0, y: 0, z: 0 };
    const airAt = (x, y, z, t, power, wind, seed) => {
      const b = 0.16 + 0.12 * Math.max(y, 0);              // 上へ行くほど広がる
      const r2 = (x * x + z * z) / (b * b);
      const core = Math.exp(-r2);
      const rise = (1.4 + 2.2 * Math.pow(power, 0.5)) / (1 + 0.28 * Math.max(y - 0.6, 0));
      air.y = rise * core + 0.12;
      const sw = 0.5 + 0.5 * core;
      air.x = wind * 0.3 * Math.min(1, y / 0.6) + sw * (Math.sin(t * 1.9 + y * 2.3 + seed * 29) * 0.75 + Math.sin(t * 4.3 + y * 5.1 + seed * 57) * 0.45);
      air.z = sw * (Math.cos(t * 2.3 + y * 2.9 + seed * 43) * 0.7 + Math.sin(t * 3.7 + y * 4.3 + seed * 15) * 0.4);
      // 巻き込み：下のほうでは空気が軸へ吸い寄せられる
      const pull = 0.5 * Math.exp(-Math.max(y, 0) * 1.2) * (1 - core);
      const rr = Math.sqrt(x * x + z * z) + 1e-3;
      air.x -= pull * x / rr;
      air.z -= pull * z / rr;
    };

    // ---- 火の粉 ----
    let sparks = null;
    if (opts.sparks) {
      const max = Math.max(1, Math.floor(opts.sparks.max || 300));
      const px = new Float32Array(max), py = new Float32Array(max), pz = new Float32Array(max);
      const vx = new Float32Array(max), vy = new Float32Array(max), vz = new Float32Array(max);
      const life = new Float32Array(max).fill(1), span = new Float32Array(max), sz = new Float32Array(max), seed = new Float32Array(max);
      const aPos = new Float32Array(max * 3), aVel = new Float32Array(max * 3), aInfo = new Float32Array(max * 3);
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3));
      geo.setIndex([0, 1, 2, 1, 3, 2]);
      const posAttr = new THREE.InstancedBufferAttribute(aPos, 3);
      const velAttr = new THREE.InstancedBufferAttribute(aVel, 3);
      const infoAttr = new THREE.InstancedBufferAttribute(aInfo, 3);
      [posAttr, velAttr, infoAttr].forEach((a) => a.setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aPos', posAttr);
      geo.setAttribute('aVel', velAttr);
      geo.setAttribute('aInfo', infoAttr);
      geo.instanceCount = 0;
      const uniforms = {
        uViewport: { value: new THREE.Vector2(1280, 720) }, uShutter: { value: 1 / 90 },
        uMinPx: { value: 1.1 }, uTime: { value: 0 },
      };
      const mat = new THREE.ShaderMaterial({
        uniforms, vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      group.add(mesh);
      let cursor = 0;
      let carry = 0;
      let burstIn = 1.5;
      const spawn = (x, y, z, speed, spreadV, power) => {
        for (let k = 0; k < max; k++) {
          const i = cursor;
          cursor = (cursor + 1) % max;
          if (life[i] < 1) continue;
          const a = Math.random() * Math.PI * 2;
          const lat = Math.random() * spreadV;
          px[i] = x; py[i] = y; pz[i] = z;
          vx[i] = Math.cos(a) * lat; vz[i] = Math.sin(a) * lat;
          vy[i] = speed * (0.5 + Math.random());
          life[i] = 0;
          // 多くはすぐ燃え尽き、ごく一部だけが高く昇る
          span[i] = (0.5 + 3.2 * Math.pow(Math.random(), 2.4)) * (0.8 + 0.2 * power);
          sz[i] = 0.0025 + 0.004 * Math.pow(Math.random(), 2);
          seed[i] = Math.random();
          return;
        }
      };
      sparks = {
        update(dt, t, count, wind, power, viewW, viewH, dpr) {
          count = Math.max(0, Math.min(max, count));
          // 絶え間なく出るぶん（count は量の目安。基準の 160 で毎秒 20 粒ほど）
          carry += dt * count / 7 * (0.5 + 0.5 * power) * (0.4 + 1.2 * Math.random());
          while (carry >= 1) {
            carry -= 1;
            const a = Math.random() * Math.PI * 2, r = Math.random() * 0.22;
            spawn(Math.cos(a) * r, 0.2 + Math.random() * 0.5 * Math.pow(power, 0.5), Math.sin(a) * r, 1.4 + 1.2 * power, 0.5, power);
          }
          // 薪がはぜる：ときどき 1 か所からまとまって飛ぶ
          burstIn -= dt;
          if (burstIn <= 0 && count > 0) {
            burstIn = (0.7 + Math.random() * 3.2) / (0.4 + 0.6 * power) * (200 / (count + 60));
            const a = Math.random() * Math.PI * 2, r = 0.05 + Math.random() * 0.2;
            const bx = Math.cos(a) * r, bz = Math.sin(a) * r, by = 0.1 + Math.random() * 0.25;
            const n = Math.round((5 + Math.random() * 22) * Math.min(1, count / 120));
            for (let k = 0; k < n; k++) spawn(bx, by, bz, 2.2 + 2.4 * Math.random(), 1.6, power);
          }
          let m = 0;
          for (let i = 0; i < max; i++) {
            if (life[i] >= 1) continue;
            life[i] += dt / span[i];
            if (life[i] >= 1 || py[i] < 0) { life[i] = 1; continue; }
            // 軽い粒：まわりの空気の速さへすばやくなじみ、重力でわずかに沈む
            airAt(px[i], py[i], pz[i], t, power, wind, seed[i]);
            const k = 1 - Math.exp(-dt / 0.22);
            vx[i] += (air.x - vx[i]) * k;
            vy[i] += (air.y - vy[i]) * k - 1.6 * dt;
            vz[i] += (air.z - vz[i]) * k;
            px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
            const o = m * 3;
            aPos[o] = px[i]; aPos[o + 1] = py[i]; aPos[o + 2] = pz[i];
            aVel[o] = vx[i]; aVel[o + 1] = vy[i]; aVel[o + 2] = vz[i];
            aInfo[o] = life[i]; aInfo[o + 1] = sz[i]; aInfo[o + 2] = seed[i];
            m++;
          }
          geo.instanceCount = m;
          posAttr.needsUpdate = true;
          velAttr.needsUpdate = true;
          infoAttr.needsUpdate = true;
          uniforms.uViewport.value.set(viewW, viewH);
          uniforms.uMinPx.value = 0.8 * dpr;
          uniforms.uTime.value = t;
        },
      };
    }

    // ---- 煙 ----
    let smoke = null;
    if (opts.smoke) {
      const max = Math.max(1, Math.floor(opts.smoke.max || 120));
      const pos = new Float32Array(max * 3), life = new Float32Array(max), size = new Float32Array(max), seeds = new Float32Array(max);
      const vx = new Float32Array(max), vy = new Float32Array(max), vz = new Float32Array(max), span = new Float32Array(max);
      const geo = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(pos, 3);
      const lifeAttr = new THREE.BufferAttribute(life, 1);
      const sizeAttr = new THREE.BufferAttribute(size, 1);
      [posAttr, lifeAttr, sizeAttr].forEach((a) => a.setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('position', posAttr);
      geo.setAttribute('aLife', lifeAttr);
      geo.setAttribute('aSize', sizeAttr);
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
      const litBase = new THREE.Color(opts.smoke.lit !== undefined ? opts.smoke.lit : 0x7a3a16);
      const uniforms = {
        tNoise: { value: noiseTex }, uScale: { value: 300 }, uTop: { value: 1 },
        uLit: { value: litBase.clone() },
        uAmbient: { value: new THREE.Color(opts.smoke.ambient !== undefined ? opts.smoke.ambient : 0x06080c) },
        uOpacity: { value: opts.smoke.opacity !== undefined ? opts.smoke.opacity : 0.2 },
      };
      const mat = new THREE.ShaderMaterial({
        uniforms, vertexShader: FIRE_SMOKE_VERT, fragmentShader: FIRE_SMOKE_FRAG,
        transparent: true, depthWrite: false, blending: THREE.NormalBlending, toneMapped: false,
      });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      points.renderOrder = 2;
      group.add(points);
      const spawn = (i, power) => {
        const a = Math.random() * Math.PI * 2, r = Math.random() * 0.14;
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = (0.55 + Math.random() * 0.5) * Math.pow(power, 0.6);
        pos[i * 3 + 2] = Math.sin(a) * r;
        vx[i] = 0; vz[i] = 0; vy[i] = 1.2;
        span[i] = 3.5 + Math.random() * 3;
        size[i] = (0.3 + Math.random() * 0.3) * (0.7 + 0.3 * power);
        seeds[i] = Math.random();
      };
      for (let i = 0; i < max; i++) { spawn(i, 1); life[i] = Math.random(); pos[i * 3 + 1] += life[i] * 3; }
      let drawn = -1;
      smoke = {
        update(dt, t, count, wind, power, pixelHeight, fl) {
          count = Math.max(0, Math.min(max, Math.floor(count)));
          for (let i = 0; i < count; i++) {
            life[i] += dt / span[i];
            if (life[i] >= 1) { spawn(i, power); life[i] = 0; }
            const o = i * 3;
            airAt(pos[o], pos[o + 1], pos[o + 2], t * 0.35, power, wind, seeds[i]);
            const k = 1 - Math.exp(-dt / 0.6);
            vx[i] += (air.x * 0.6 + wind * 0.25 - vx[i]) * k;
            vy[i] += (Math.max(air.y * 0.55, 0.35) - vy[i]) * k;
            vz[i] += (air.z * 0.6 - vz[i]) * k;
            pos[o] += vx[i] * dt; pos[o + 1] += vy[i] * dt; pos[o + 2] += vz[i] * dt;
          }
          posAttr.needsUpdate = true;
          lifeAttr.needsUpdate = true;
          sizeAttr.needsUpdate = true;
          if (drawn !== count) { geo.setDrawRange(0, count); drawn = count; }
          uniforms.uScale.value = pixelHeight * 0.5;
          uniforms.uTop.value = 1.1 * Math.pow(power, 0.6);
          uniforms.uLit.value.copy(litBase).multiplyScalar(fl * Math.pow(power, 0.7));
        },
      };
    }

    // p = { power, wind, sparks, smoke, viewWidth, viewHeight, pixelRatio }
    //   viewWidth / viewHeight は描画バッファの大きさ（px）。火の粉の太さと煙の大きさを画面に合わせる
    function update(dt, t, p) {
      p = p || {};
      const power = p.power !== undefined ? p.power : 1;
      const wind = p.wind || 0;
      const viewW = p.viewWidth || 1280, viewH = p.viewHeight || 720, dpr = p.pixelRatio || 1;
      if (camera) group.rotation.y = Math.atan2(camera.position.x - group.position.x, camera.position.z - group.position.z);
      const fast = flickerNoise.sample(t, 1.2);
      if (simulated) {
        // 光の明滅は、火元の強さ（＝このあと炎が伸びる量）に細かいゆらぎを足したもの
        const level = stepSims(dt, power, wind);
        flicker.value = 0.62 + 0.62 * level + fast * 0.09;
      } else {
        flicker.value = 1 + fast * 0.2;
        fallback.update(dt, t, { power, wind });
      }
      if (sparks) sparks.update(dt, t, p.sparks !== undefined ? p.sparks : 0, wind, power, viewW, viewH, dpr);
      if (smoke) smoke.update(dt, t, p.smoke !== undefined ? p.smoke : 0, wind, power, viewH, flicker.value);
    }

    function dispose() {
      disposables.forEach((d) => d.dispose());
    }

    return { group, flicker, update, dispose, simulated };
  }

  /**
   * ポストエフェクト：HDR のレンダーターゲットにシーンを描き、ブルーム（発光の滲み）と
   * 陽炎（炎の上の空気の歪み）を掛けてから ACES トーンマッピングと sRGB 変換をして画面に出す。
   * ブルームは解像度を半分ずつ落とした levels 段のぼかしを足し合わせる：細い光（火の粉）のまわりの小さな滲みから、
   * 炎を包む大きな光の暈までを一度に作る。最後に粒状のノイズ（フィルムグレイン）をわずかに足して、
   * 暗い空のグラデーションに出る縞（バンディング）を消す。
   * 使うシーンは create で renderer.toneMapping を NoToneMapping にし（HDR のまま RT に描くため）、
   * render(scene, camera, { time, haze, bloom, exposure }) をシーンの render フックから呼び、dispose で dispose() を呼ぶ。
   *   haze = { x, y, width, height, strength, lean }：x, y は画面上の位置（0〜1、左下原点）、width / height は
   *   歪ませる範囲（画面の高さを 1 とした単位）、strength は歪みの強さ（0 で無効）、lean は上へ行くほど横へ流す量
   */
  const POST_VERT = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;
  const BRIGHT_FRAG = `
    uniform sampler2D tDiffuse;
    uniform float uThreshold;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float k = smoothstep(uThreshold, uThreshold + 0.8, l);
      // 極端に明るい点（火の粉）がブルームでちらつかないように上限を掛ける
      gl_FragColor = vec4(min(c * k, vec3(24.0)), 1.0);
    }
  `;
  const DOWN_FRAG = `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;   // 読む側の 1 画素
    varying vec2 vUv;
    void main() {
      vec3 s = texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0)).rgb
             + texture2D(tDiffuse, vUv + uTexel * vec2(1.0, -1.0)).rgb
             + texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, 1.0)).rgb
             + texture2D(tDiffuse, vUv + uTexel * vec2(1.0, 1.0)).rgb;
      gl_FragColor = vec4(s * 0.25, 1.0);
    }
  `;
  const BLUR_FRAG = `
    uniform sampler2D tDiffuse;
    uniform vec2 uDir;
    varying vec2 vUv;
    void main() {
      vec3 s = texture2D(tDiffuse, vUv).rgb * 0.227;
      s += texture2D(tDiffuse, vUv + uDir * 1.385).rgb * 0.316;
      s += texture2D(tDiffuse, vUv - uDir * 1.385).rgb * 0.316;
      s += texture2D(tDiffuse, vUv + uDir * 3.231).rgb * 0.070;
      s += texture2D(tDiffuse, vUv - uDir * 3.231).rgb * 0.070;
      gl_FragColor = vec4(s, 1.0);
    }
  `;
  const POST_LEVELS = 5;
  const COMPOSITE_FRAG = NOISE_GLSL + `
    uniform sampler2D tScene;
    uniform sampler2D tBloom0;
    uniform sampler2D tBloom1;
    uniform sampler2D tBloom2;
    uniform sampler2D tBloom3;
    uniform sampler2D tBloom4;
    uniform float uWeights[${POST_LEVELS}];
    uniform float uBloom;
    uniform float uExposure;
    uniform float uTime;
    uniform vec4 uHaze;
    uniform float uHazeStrength;
    uniform float uHazeLean;
    uniform float uAspect;
    uniform float uVignette;
    uniform float uGrain;
    uniform vec2 uResolution;
    varying vec2 vUv;
    vec3 aces(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c) {
      vec3 lo = c * 12.92;
      vec3 hi = pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055;
      return mix(hi, lo, step(c, vec3(0.0031308)));
    }
    void main() {
      vec2 uv = vUv;
      // 陽炎：炎の上の縦長の範囲で、上向きに流れるノイズ分だけサンプル位置をずらす
      vec2 d = (uv - uHaze.xy) * vec2(uAspect, 1.0);
      float dy = d.y / max(uHaze.w, 0.001);
      float dx = (d.x - uHazeLean * max(d.y, 0.0)) / max(uHaze.z * (1.0 + max(dy, 0.0) * 0.8), 0.001);
      float mask = exp(-dx * dx * 2.5) * smoothstep(-0.15, 0.25, dy) * (1.0 - smoothstep(0.5, 1.3, dy));
      vec2 np = vec2(uv.x * 26.0 * uAspect, uv.y * 15.0 - uTime * 1.9);
      vec2 off = vec2(vnoise(np) - 0.5, vnoise(np + 7.3) - 0.5) * 0.7
               + vec2(vnoise(np * 2.3 + 3.1) - 0.5, vnoise(np * 2.3 + 11.7) - 0.5) * 0.3;
      off *= uHazeStrength * mask;
      vec3 col = texture2D(tScene, uv + off).rgb;
      vec2 bu = uv + off * 0.5;
      vec3 bloom = texture2D(tBloom0, bu).rgb * uWeights[0]
                 + texture2D(tBloom1, bu).rgb * uWeights[1]
                 + texture2D(tBloom2, bu).rgb * uWeights[2]
                 + texture2D(tBloom3, bu).rgb * uWeights[3]
                 + texture2D(tBloom4, bu).rgb * uWeights[4];
      col += bloom * uBloom;
      col *= uExposure;
      col = aces(col);
      vec2 v = vUv - 0.5;
      col *= 1.0 - dot(v, v) * uVignette;
      col = toSRGB(col);
      // 粒状ノイズ：暗部ほど目立つフィルムの粒。最小でも 1 階調ぶんは足して、暗いグラデーションの縞を崩す
      vec2 gp = vUv * uResolution + fract(uTime * 7.31) * vec2(113.0, 71.0);
      float g = fract(sin(dot(floor(gp), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col += g * (uGrain * (1.0 - 0.6 * lum) + 1.5 / 255.0);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function makePost(THREE, renderer, opts) {
    opts = opts || {};
    const gl2 = !!(renderer.capabilities && renderer.capabilities.isWebGL2);
    // 半精度浮動小数に描けるか。iOS などは EXT_color_buffer_half_float だけを持つ
    const hdr = gl2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
    const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;

    const base = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type, stencilBuffer: false };
    const sceneRT = (gl2 && THREE.WebGLMultisampleRenderTarget)
      ? new THREE.WebGLMultisampleRenderTarget(1, 1, Object.assign({ depthBuffer: true }, base))
      : new THREE.WebGLRenderTarget(1, 1, Object.assign({ depthBuffer: true }, base));
    // ブルームの段：1/2, 1/4, 1/8 … の解像度。各段に 2 枚（ぼかしの往復用）
    const levels = [];
    for (let i = 0; i < POST_LEVELS; i++) {
      levels.push({
        a: new THREE.WebGLRenderTarget(1, 1, Object.assign({ depthBuffer: false }, base)),
        b: new THREE.WebGLRenderTarget(1, 1, Object.assign({ depthBuffer: false }, base)),
      });
    }

    const quadScene = new THREE.Scene();
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    quad.frustumCulled = false;
    quadScene.add(quad);

    const mk = (frag, uniforms) => new THREE.ShaderMaterial({ uniforms, vertexShader: POST_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, toneMapped: false });
    const brightMat = mk(BRIGHT_FRAG, { tDiffuse: { value: null }, uThreshold: { value: opts.threshold !== undefined ? opts.threshold : (hdr ? 0.9 : 0.6) } });
    const downMat = mk(DOWN_FRAG, { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } });
    const blurMat = mk(BLUR_FRAG, { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } });
    const compMat = mk(COMPOSITE_FRAG, {
      tScene: { value: null },
      tBloom0: { value: levels[0].a.texture },
      tBloom1: { value: levels[1].a.texture },
      tBloom2: { value: levels[2].a.texture },
      tBloom3: { value: levels[3].a.texture },
      tBloom4: { value: levels[4].a.texture },
      // 細かい段ほど芯の滲み、粗い段ほど広い暈
      uWeights: { value: opts.weights || [0.3, 0.26, 0.2, 0.14, 0.1] },
      uBloom: { value: opts.bloom !== undefined ? opts.bloom : 0.8 },
      uExposure: { value: 1 },
      uTime: { value: 0 },
      uHaze: { value: new THREE.Vector4(0.5, 0.5, 0.1, 0.3) },
      uHazeStrength: { value: 0 },
      uHazeLean: { value: 0 },
      uAspect: { value: 1 },
      uVignette: { value: opts.vignette !== undefined ? opts.vignette : 0.35 },
      uGrain: { value: opts.grain !== undefined ? opts.grain : 0.02 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    });

    const size = new THREE.Vector2();
    let w = 0, h = 0;
    function ensureSize() {
      renderer.getDrawingBufferSize(size);
      if (size.x === w && size.y === h) return;
      w = size.x; h = size.y;
      sceneRT.setSize(w, h);
      let lw = w, lh = h;
      for (let i = 0; i < POST_LEVELS; i++) {
        lw = Math.max(1, Math.floor(lw / 2));
        lh = Math.max(1, Math.floor(lh / 2));
        levels[i].a.setSize(lw, lh);
        levels[i].b.setSize(lw, lh);
      }
    }

    function pass(mat, target) {
      quad.material = mat;
      renderer.setRenderTarget(target);
      renderer.render(quadScene, quadCam);
    }

    // p = { time, haze, bloom, exposure }
    function render(scene, camera, p) {
      p = p || {};
      ensureSize();
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);

      // 明るい部分だけを 1/2 解像度へ抜き出し、段ごとに「縮小 → 横ぼかし → 縦ぼかし」
      brightMat.uniforms.tDiffuse.value = sceneRT.texture;
      pass(brightMat, levels[0].b);
      for (let i = 0; i < POST_LEVELS; i++) {
        const lv = levels[i];
        if (i > 0) {
          const src = levels[i - 1].a;
          downMat.uniforms.tDiffuse.value = src.texture;
          downMat.uniforms.uTexel.value.set(0.5 / src.width, 0.5 / src.height);
          pass(downMat, lv.b);
        }
        blurMat.uniforms.tDiffuse.value = lv.b.texture;
        blurMat.uniforms.uDir.value.set(1 / lv.a.width, 0);
        pass(blurMat, lv.a);
        blurMat.uniforms.tDiffuse.value = lv.a.texture;
        blurMat.uniforms.uDir.value.set(0, 1 / lv.a.height);
        pass(blurMat, lv.b);
        const t = lv.a; lv.a = lv.b; lv.b = t; // 結果は常に a に置く
      }

      const u = compMat.uniforms;
      u.tScene.value = sceneRT.texture;
      u.tBloom0.value = levels[0].a.texture;
      u.tBloom1.value = levels[1].a.texture;
      u.tBloom2.value = levels[2].a.texture;
      u.tBloom3.value = levels[3].a.texture;
      u.tBloom4.value = levels[4].a.texture;
      u.uTime.value = p.time || 0;
      u.uAspect.value = w / Math.max(1, h);
      u.uResolution.value.set(w, h);
      u.uExposure.value = p.exposure !== undefined ? p.exposure : renderer.toneMappingExposure;
      if (p.bloom !== undefined) u.uBloom.value = p.bloom;
      const hz = p.haze;
      if (hz) {
        u.uHaze.value.set(hz.x, hz.y, hz.width || 0.12, hz.height || 0.35);
        u.uHazeStrength.value = hz.strength || 0;
        u.uHazeLean.value = hz.lean || 0;
      } else {
        u.uHazeStrength.value = 0;
      }
      pass(compMat, null);
    }

    function dispose() {
      renderer.setRenderTarget(null);
      sceneRT.dispose();
      levels.forEach((lv) => { lv.a.dispose(); lv.b.dispose(); });
      [brightMat, downMat, blurMat, compMat].forEach((m) => m.dispose());
      quad.geometry.dispose();
    }

    return { render, dispose, hdr };
  }

  const helpers = { makeRain, makeRipples, makeGrass, makeFlame, makeFire, makePost, makeFluctuation, makeNoiseTexture: makeFlameNoise };


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
      installBtn: document.getElementById('install'),
    };

    setupPwa();

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

  /* ================================================================ */
  /* PWA                                                               */
  /* ================================================================ */

  function setupPwa() {
    // Service Worker：http(s) で開いたときだけ登録する（file:// では動かない）
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((e) => console.warn('madobe: Service Worker を登録できませんでした', e));
      });
    }

    // インストールボタン：ブラウザが beforeinstallprompt を出したときだけ表示する
    let deferred = null;
    const btn = dom.installBtn;
    if (!btn) return;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      btn.hidden = false;
    });
    btn.addEventListener('click', () => {
      if (!deferred) return;
      const ev = deferred;
      deferred = null;
      btn.hidden = true;
      ev.prompt();
      if (ev.userChoice) ev.userChoice.then((r) => { if (r && r.outcome !== 'accepted') { deferred = ev; btn.hidden = false; } }).catch(() => {});
    });
    window.addEventListener('appinstalled', () => { deferred = null; btn.hidden = true; });
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
    renderer.setRenderTarget(null);
    renderer.shadowMap.enabled = false;
    renderer.physicallyCorrectLights = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
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
    if (!current.broken && h && typeof h.render === 'function') {
      try {
        h.render(renderer, current.scene, current.camera);
      } catch (e) {
        console.error('madobe: シーン "' + current.id + '" の render でエラー', e);
        current.broken = true;
        notice('シーン「' + (current.def.name || current.id) + '」の描画でエラーが起きました。コンソールを確認してください。');
        renderer.setRenderTarget(null);
      }
    } else {
      renderer.render(current.scene, current.camera);
    }
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
