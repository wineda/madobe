/* madobe — アプリ本体
 *
 * 役割：
 *   - THREE.WebGLRenderer を1つだけ作り、全シーンで共有する
 *   - シーンの登録（madobe.register）・切替（URL ハッシュ）・破棄
 *   - シーン定義の params からスライダーを自動生成する
 *   - PWA：Service Worker の登録と「インストール」ボタン
 *   - 共通ヘルパー（雨・波紋・草・炎）を ctx.helpers で渡す
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
      const xz = placer(i);
      const h = height[0] + Math.random() * (height[1] - height[0]);
      pv.set(xz[0], 0, xz[1]);
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
   * 形と色はフラグメントシェーダーで作る：3D シンプレックスノイズを上向きに流し、ドメインワープで
   * 輪郭を巻き込ませ、温度に応じた黒体放射風の色（暗赤→橙→黄→白、根元にかすかな青）を付ける。
   * テクスチャは不要。加算合成で HDR 値を出すので、makePost のブルームと組み合わせると芯が発光する。
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
  const FLAME_FRAG = NOISE_GLSL + `
    uniform float uTime;
    uniform float uWind;
    uniform float uPower;
    uniform float uSeed;
    uniform float uAlpha;
    uniform float uBright;
    varying vec2 vUv;

    void main() {
      float y = vUv.y;                 // 0 = 根元, 1 = 先端
      float x = vUv.x * 2.0 - 1.0;     // -1 .. 1
      // 風で先端ほど流される
      x -= uWind * 0.3 * y * y;
      // 上向きに流れるノイズ。ドメインワープで渦を巻き込ませる
      vec3 p = vec3(x * 1.8, y * 2.2 - uTime * 1.9, uSeed + uTime * 0.35);
      vec2 q = vec2(fbm(p), fbm(p + vec3(5.2, 1.3, 0.0)));
      float n = fbm(p + vec3(q * 0.9, 0.0));                 // -1 .. 1
      float n2 = fbm(p * 1.7 + vec3(q * 0.5, 2.0));
      x += n * (0.25 + y * 0.9);
      // 先端に向かって細くなる幅。n2 で太さも揺らす
      float w = 0.85 * pow(max(1.0 - y, 0.0), 0.6) * (0.85 + 0.3 * n2);
      float d = abs(x) / max(w, 0.001);
      float yy = y + n * 0.35;                               // 先端はノイズで千切れる
      float v = (1.0 - d * d) * (1.0 - smoothstep(0.5, 1.0, yy));
      v *= smoothstep(0.0, 0.18, y);                         // 根元をぼかす
      v *= 0.75 + 0.5 * n2;
      v *= 0.85 + 0.15 * uPower;
      if (v <= 0.0) discard;
      float alpha = smoothstep(0.0, 0.3, v);
      // 温度：根元の中心ほど高い → 黒体放射風の色
      float T = clamp(v * (1.15 - y * 0.55) * smoothstep(0.0, 0.3, y), 0.0, 1.0);
      vec3 col = mix(vec3(0.35, 0.02, 0.0), vec3(1.0, 0.32, 0.03), smoothstep(0.0, 0.35, T));
      col = mix(col, vec3(1.0, 0.78, 0.22), smoothstep(0.35, 0.7, T));
      col = mix(col, vec3(1.0, 0.96, 0.86), smoothstep(0.7, 1.0, T));
      float hdr = uBright * (0.6 + 1.6 * T * T);
      gl_FragColor = vec4(col * hdr, alpha * uAlpha);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }
  `;
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

    const geo = new THREE.PlaneGeometry(1, 1, 1, 8);
    geo.translate(0, 0.5, 0); // 根元を原点に
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

    // p = { power, wind, embers, smoke, pixelHeight }
    //   power は火の勢い（1 が基準）、wind は風、embers / smoke は粒の表示数、
    //   pixelHeight は描画バッファの高さ（粒の大きさを画面サイズに合わせる。省略時は 600）
    function update(dt, t, p) {
      p = p || {};
      const power = p.power !== undefined ? p.power : 1;
      const wind = p.wind || 0;
      // 炎の拍：周期の違う sin を重ねて不規則に見せる
      flicker.value = 1 + Math.sin(t * 9.3) * 0.08 + Math.sin(t * 17.1 + 1.3) * 0.06 + Math.sin(t * 29.7 + 0.4) * 0.04;
      const h = height * Math.pow(power, 0.6) * (0.92 + flicker.value * 0.08);
      const w = width * Math.pow(power, 0.35);
      if (camera) group.rotation.y = Math.atan2(camera.position.x - group.position.x, camera.position.z - group.position.z);
      for (let i = 0; i < layers; i++) {
        const u = uniformsList[i];
        u.uTime.value = t * (0.9 + i * 0.12);
        u.uWind.value = wind;
        u.uPower.value = power;
        const k = i === 0 ? 0.6 : 1 - (i - 1) * (0.35 / layers);
        meshes[i].scale.set(w * k, h * (i === 0 ? 0.85 : 1 - (i - 1) * 0.06), 1);
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
   * ポストエフェクト：HDR のレンダーターゲットにシーンを描き、ブルーム（発光の滲み）と
   * 陽炎（炎の上の空気の歪み）を掛けてから ACES トーンマッピングと sRGB 変換をして画面に出す。
   * 使うシーンは create で renderer.toneMapping を NoToneMapping にし（HDR のまま RT に描くため）、
   * dispose で元に戻すこと。render(scene, camera, { haze, bloom, exposure }) をシーンの render フックから呼ぶ。
   *   haze = { x, y, width, height, strength }：x, y は画面上の位置（0〜1、左下原点）、width / height は
   *   歪ませる範囲（画面の高さを 1 とした単位）、strength は歪みの強さ（0 で無効）
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
      gl_FragColor = vec4(c * k, 1.0);
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
  const COMPOSITE_FRAG = NOISE_GLSL + `
    uniform sampler2D tScene;
    uniform sampler2D tBloom;
    uniform float uBloom;
    uniform float uExposure;
    uniform float uTime;
    uniform vec4 uHaze;
    uniform float uHazeStrength;
    uniform float uAspect;
    uniform float uVignette;
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
      float dx = d.x / max(uHaze.z, 0.001);
      float dy = d.y / max(uHaze.w, 0.001);
      float mask = exp(-dx * dx * 2.5) * smoothstep(-0.15, 0.25, dy) * (1.0 - smoothstep(0.5, 1.3, dy));
      vec2 np = vec2(uv.x * 22.0 * uAspect, uv.y * 14.0 - uTime * 1.6);
      vec2 off = vec2(vnoise(np) - 0.5, vnoise(np + 7.3) - 0.5) * uHazeStrength * mask;
      vec3 col = texture2D(tScene, uv + off).rgb;
      col += texture2D(tBloom, uv + off * 0.5).rgb * uBloom;
      col *= uExposure;
      col = aces(col);
      vec2 v = vUv - 0.5;
      col *= 1.0 - dot(v, v) * uVignette;
      gl_FragColor = vec4(toSRGB(col), 1.0);
    }
  `;

  function makePost(THREE, renderer, opts) {
    opts = opts || {};
    const gl2 = !!(renderer.capabilities && renderer.capabilities.isWebGL2);
    const hdr = gl2 && renderer.extensions.has('EXT_color_buffer_float');
    const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const bloomScale = opts.bloomScale || 4; // ブルームは 1/4 解像度で計算する

    const base = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type, stencilBuffer: false };
    const sceneRT = (gl2 && THREE.WebGLMultisampleRenderTarget)
      ? new THREE.WebGLMultisampleRenderTarget(1, 1, Object.assign({ depthBuffer: true }, base))
      : new THREE.WebGLRenderTarget(1, 1, Object.assign({ depthBuffer: true }, base));
    const brightRT = new THREE.WebGLRenderTarget(1, 1, Object.assign({ depthBuffer: false }, base));
    const blurA = new THREE.WebGLRenderTarget(1, 1, Object.assign({ depthBuffer: false }, base));
    const blurB = new THREE.WebGLRenderTarget(1, 1, Object.assign({ depthBuffer: false }, base));

    const quadScene = new THREE.Scene();
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    quad.frustumCulled = false;
    quadScene.add(quad);

    const mk = (frag, uniforms) => new THREE.ShaderMaterial({ uniforms, vertexShader: POST_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, toneMapped: false });
    const brightMat = mk(BRIGHT_FRAG, { tDiffuse: { value: null }, uThreshold: { value: opts.threshold !== undefined ? opts.threshold : (hdr ? 0.9 : 0.6) } });
    const blurMat = mk(BLUR_FRAG, { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } });
    const compMat = mk(COMPOSITE_FRAG, {
      tScene: { value: null },
      tBloom: { value: null },
      uBloom: { value: opts.bloom !== undefined ? opts.bloom : 0.8 },
      uExposure: { value: 1 },
      uTime: { value: 0 },
      uHaze: { value: new THREE.Vector4(0.5, 0.5, 0.1, 0.3) },
      uHazeStrength: { value: 0 },
      uAspect: { value: 1 },
      uVignette: { value: opts.vignette !== undefined ? opts.vignette : 0.35 },
    });

    const size = new THREE.Vector2();
    let w = 0, h = 0;
    function ensureSize() {
      renderer.getDrawingBufferSize(size);
      if (size.x === w && size.y === h) return;
      w = size.x; h = size.y;
      sceneRT.setSize(w, h);
      const bw = Math.max(1, Math.floor(w / bloomScale));
      const bh = Math.max(1, Math.floor(h / bloomScale));
      brightRT.setSize(bw, bh);
      blurA.setSize(bw, bh);
      blurB.setSize(bw, bh);
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

      brightMat.uniforms.tDiffuse.value = sceneRT.texture;
      pass(brightMat, brightRT);
      // 2 回のぼかし（半径 1 と 2）で広く柔らかく滲ませる
      let src = brightRT;
      for (let r = 1; r <= 2; r++) {
        blurMat.uniforms.tDiffuse.value = src.texture;
        blurMat.uniforms.uDir.value.set(r / brightRT.width, 0);
        pass(blurMat, blurA);
        blurMat.uniforms.tDiffuse.value = blurA.texture;
        blurMat.uniforms.uDir.value.set(0, r / brightRT.height);
        pass(blurMat, blurB);
        src = blurB;
      }

      const u = compMat.uniforms;
      u.tScene.value = sceneRT.texture;
      u.tBloom.value = blurB.texture;
      u.uTime.value = p.time || 0;
      u.uAspect.value = w / Math.max(1, h);
      u.uExposure.value = p.exposure !== undefined ? p.exposure : renderer.toneMappingExposure;
      if (p.bloom !== undefined) u.uBloom.value = p.bloom;
      const hz = p.haze;
      if (hz) {
        u.uHaze.value.set(hz.x, hz.y, hz.width || 0.12, hz.height || 0.35);
        u.uHazeStrength.value = hz.strength || 0;
      } else {
        u.uHazeStrength.value = 0;
      }
      pass(compMat, null);
    }

    function dispose() {
      renderer.setRenderTarget(null);
      [sceneRT, brightRT, blurA, blurB].forEach((rt) => rt.dispose());
      [brightMat, blurMat, compMat].forEach((m) => m.dispose());
      quad.geometry.dispose();
    }

    return { render, dispose, hdr };
  }

  const helpers = { makeRain, makeRipples, makeGrass, makeFlame, makePost, makeFluctuation };


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
