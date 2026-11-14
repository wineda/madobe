/* 焚き火 — 夜の森の空き地。石で囲った焚き火を、腰を下ろした目の高さから眺める。
 *
 * 炎は helpers.makeFire（流体シミュレーション）、仕上げは helpers.makePost（ブルーム・陽炎・グレイン）。
 * 画像ファイルは使わず、質感（地面・石・樹皮・炭・木立）はすべて起動時に Canvas で描いて作る。
 * 景色は毎回同じになるよう、種を固定した乱数で配置する。
 */
(function () {
  'use strict';

  /* ================================================================ */
  /* 小道具                                                            */
  /* ================================================================ */

  // 種から決まった乱数列を作る（mulberry32）
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;

  function newCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // 継ぎ目なく繰り返す fBm（0〜1）。cells は最も粗い格子の数。cellsY を変えると一方向に伸びた模様になる
  function fbmTile(size, cells, octaves, rnd, gain, cellsY) {
    gain = gain === undefined ? 0.5 : gain;
    let cy = cellsY || cells, cx = cells;
    const out = new Float32Array(size * size);
    let amp = 1, total = 0;
    const axis = (n) => {
      const f = new Float32Array(size), i0 = new Int32Array(size), i1 = new Int32Array(size);
      for (let p = 0; p < size; p++) {
        const g = (p / size) * n;
        const k = Math.floor(g);
        let t = g - k;
        t = t * t * t * (t * (t * 6 - 15) + 10);
        f[p] = t; i0[p] = k % n; i1[p] = (k + 1) % n;
      }
      return { f, i0, i1 };
    };
    for (let o = 0; o < octaves && cx <= size && cy <= size; o++, cx *= 2, cy *= 2) {
      const lat = new Float32Array(cx * cy);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      const X = axis(cx), Y = axis(cy);
      for (let py = 0; py < size; py++) {
        const fy = Y.f[py], r0 = Y.i0[py] * cx, r1 = Y.i1[py] * cx;
        const row = py * size;
        for (let px = 0; px < size; px++) {
          const fx = X.f[px], c0 = X.i0[px], c1 = X.i1[px];
          const top = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * fx;
          const bot = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * fx;
          out[row + px] += (top + (bot - top) * fy) * amp;
        }
      }
      total += amp;
      amp *= gain;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
  }

  // m×m の繰り返し模様を n×n へなめらかに引き伸ばす。ゆるやかな成分は小さく作って拡大すれば十分で、生成が速い
  function upsample(src, m, n) {
    const out = new Float32Array(n * n);
    const k = m / n;
    const i0 = new Int32Array(n), i1 = new Int32Array(n), f = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const g = p * k, a = Math.floor(g);
      i0[p] = a % m; i1[p] = (a + 1) % m; f[p] = g - a;
    }
    for (let y = 0; y < n; y++) {
      const r0 = i0[y] * m, r1 = i1[y] * m, fy = f[y], row = y * n;
      for (let x = 0; x < n; x++) {
        const a = src[r0 + i0[x]] + (src[r0 + i1[x]] - src[r0 + i0[x]]) * f[x];
        const b = src[r1 + i0[x]] + (src[r1 + i1[x]] - src[r1 + i0[x]]) * f[x];
        out[row + x] = a + (b - a) * fy;
      }
    }
    return out;
  }

  // 継ぎ目なく繰り返すセルノイズ（ボロノイ）。f1 = 最も近い点までの距離、f2 = 2 番目、id = 最も近い点の乱数
  function worleyTile(size, cx, cy, rnd) {
    const ptx = new Float32Array(cx * cy), pty = new Float32Array(cx * cy), pid = new Float32Array(cx * cy);
    for (let i = 0; i < cx * cy; i++) { ptx[i] = rnd(); pty[i] = rnd(); pid[i] = rnd(); }
    const f1 = new Float32Array(size * size), f2 = new Float32Array(size * size), id = new Float32Array(size * size);
    for (let py = 0; py < size; py++) {
      const gy = (py / size) * cy, iy = Math.floor(gy);
      for (let px = 0; px < size; px++) {
        const gx = (px / size) * cx, ix = Math.floor(gx);
        let a = 9, b = 9, who = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const yy = ((iy + oy) % cy + cy) % cy;
          for (let ox = -1; ox <= 1; ox++) {
            const xx = ((ix + ox) % cx + cx) % cx;
            const k = yy * cx + xx;
            const dx = ix + ox + ptx[k] - gx, dy = iy + oy + pty[k] - gy;
            const d = dx * dx + dy * dy;
            if (d < a) { b = a; a = d; who = pid[k]; } else if (d < b) { b = d; }
          }
        }
        const o = py * size + px;
        f1[o] = Math.sqrt(a); f2[o] = Math.sqrt(b); id[o] = who;
      }
    }
    return { f1, f2, id };
  }

  // 高さの配列から法線マップ（タンジェント空間）を作る
  function normalCanvas(height, size, strength) {
    const c = newCanvas(size, size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      const yu = ((y - 1 + size) % size) * size, yd = ((y + 1) % size) * size, row = y * size;
      for (let x = 0; x < size; x++) {
        const xl = (x - 1 + size) % size, xr = (x + 1) % size;
        const dx = (height[row + xr] - height[row + xl]) * strength;
        const dy = (height[yd + x] - height[yu + x]) * strength;
        // テクスチャは上下反転して貼られるので、画像の下向き＝ v の負の向き
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
        const o = (row + x) * 4;
        img.data[o] = (-dx * inv * 0.5 + 0.5) * 255;
        img.data[o + 1] = (dy * inv * 0.5 + 0.5) * 255;
        img.data[o + 2] = (inv * 0.5 + 0.5) * 255;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // 複数の形状を 1 つにまとめる（位置・法線・UV・頂点色）。ドローコールと影の描画回数を減らすため
  function mergeGeometries(THREE, items) {
    let count = 0;
    const parts = items.map((it) => {
      const g = it.geometry.index ? it.geometry.toNonIndexed() : it.geometry.clone();
      if (it.matrix) g.applyMatrix4(it.matrix);
      count += g.attributes.position.count;
      return { g, color: it.color };
    });
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2), col = new Float32Array(count * 3);
    let o = 0;
    parts.forEach(({ g, color }) => {
      const n = g.attributes.position.count;
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
      const src = g.attributes.color ? g.attributes.color.array : null;
      const cr = color ? color[0] : 1, cg = color ? color[1] : 1, cb = color ? color[2] : 1;
      for (let i = 0; i < n; i++) {
        col[(o + i) * 3] = (src ? src[i * 3] : 1) * cr;
        col[(o + i) * 3 + 1] = (src ? src[i * 3 + 1] : 1) * cg;
        col[(o + i) * 3 + 2] = (src ? src[i * 3 + 2] : 1) * cb;
      }
      o += n;
      g.dispose();
    });
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return out;
  }

  // ワールド座標をフラグメントシェーダーへ渡す（MeshStandardMaterial の onBeforeCompile 用）
  function injectWorldPos(shader) {
    shader.vertexShader = 'varying vec3 vWp;\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
       vec4 wpos = vec4(transformed, 1.0);
       #ifdef USE_INSTANCING
         wpos = instanceMatrix * wpos;
       #endif
       vWp = (modelMatrix * wpos).xyz;`);
    shader.fragmentShader = 'varying vec3 vWp;\n' + shader.fragmentShader;
  }

  // 炎は点ではなく面で光るので、影の縁は広くぼける。three.js の点光源の影（9 点の平均）を、
  // 光の向きに垂直な面内で画素ごとに回した渦巻き状の taps 点に差し替える。shadow.radius は縁の幅（×0.01 ラジアン）
  function softPointShadows(THREE, shader, taps) {
    const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
    const a = chunk.indexOf('vec2 offset = vec2( - 1, 1 ) * shadowRadius * texelSize.y;');
    const b = chunk.indexOf('#else', a);
    if (a < 0 || b < 0) return; // three.js の版が違って見つからなければ、元の影のまま
    const n = taps.toFixed(1);
    const soft = `
      vec3 st1 = normalize( cross( bd3D, abs( bd3D.y ) < 0.9 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 ) ) );
      vec3 st2 = cross( bd3D, st1 );
      float sAng = 6.2831853 * fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
      float sSum = 0.0;
      for ( int si = 0; si < ${taps}; si ++ ) {
        float sr = sqrt( ( float( si ) + 0.5 ) / ${n} ) * shadowRadius * 0.01;
        float sa = sAng + float( si ) * 2.39996323;
        sSum += texture2DCompare( shadowMap, cubeToUV( bd3D + ( st1 * cos( sa ) + st2 * sin( sa ) ) * sr, texelSize.y ), dp );
      }
      return sSum / ${n};
    `;
    shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', chunk.slice(0, a) + soft + chunk.slice(b));
  }

  // 炎のすぐそばの面は、点光源の計算だと距離の 2 乗で際限なく明るくなる。実際の炎は広がりのある光源で
  // 受ける光には上限があるので、面に届く光の量（放射照度）をなだらかに頭打ちにする（cap が上限）。
  // 色を掛ける前の段階で抑えるので、灰や炭の色むらはそのまま残る
  function capDirectLight(THREE, shader, cap) {
    const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
    const key = 'vec3 irradiance = dotNL * directLight.color;';
    if (chunk.indexOf(key) < 0) return; // three.js の版が違って見つからなければ、何もしない
    const c = cap.toFixed(3);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_pars_fragment>',
      chunk.replace(key, key + '\n\tirradiance *= ' + c + ' / ( ' + c + ' + max( irradiance.r, max( irradiance.g, irradiance.b ) ) );'));
  }

  /* ================================================================ */
  /* 形状                                                              */
  /* ================================================================ */

  // 細かく割った正二十面体（単位球）のひな形。同じ位置に重なっている頂点の対応表（ids）を一度だけ作っておき、
  // 石ごとの法線の平均に使い回す（面ごとに頂点が分かれた形状のままでは、陰影に継ぎ目が出るため）
  const icoCache = {};
  function icoTemplate(THREE, detail) {
    if (icoCache[detail]) return icoCache[detail];
    const g = new THREE.IcosahedronGeometry(1, detail);
    const pos = g.attributes.position.array;
    const n = pos.length / 3;
    const ids = new Int32Array(n);
    const seen = new Map();
    let unique = 0;
    for (let i = 0; i < n; i++) {
      const key = (Math.round(pos[i * 3] * 1e4) + 1e4) * 400040001 + (Math.round(pos[i * 3 + 1] * 1e4) + 1e4) * 20001 + Math.round(pos[i * 3 + 2] * 1e4) + 1e4;
      let id = seen.get(key);
      if (id === undefined) { id = unique++; seen.set(key, id); }
      ids[i] = id;
    }
    const t = { dirs: new Float32Array(pos), uv: new Float32Array(g.attributes.uv.array), ids, unique, count: n };
    g.dispose();
    icoCache[detail] = t;
    return t;
  }

  // 石：細かく割った球を、なめらかな凹凸と数枚の平らな面でゆがめる。法線は同じ位置の頂点で平均して継ぎ目を消す
  function rockGeometry(THREE, radius, detail, rnd, squash) {
    const t = icoTemplate(THREE, detail);
    const n = t.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    const seed = rnd() * 100;
    const planes = [];
    for (let k = 0; k < 5; k++) {
      const px = rnd() * 2 - 1, py = rnd() * 1.4 - 0.5, pz = rnd() * 2 - 1;
      const l = Math.hypot(px, py, pz) || 1;
      planes.push([px / l, py / l, pz / l, radius * (0.62 + 0.3 * rnd())]);
    }
    for (let i = 0; i < n; i++) {
      const dx = t.dirs[i * 3], dy = t.dirs[i * 3 + 1], dz = t.dirs[i * 3 + 2];
      // 向きだけで決まるなめらかな凹凸（同じ位置の頂点は同じだけ動くので面が割れない）
      const k = radius * (1
        + 0.14 * Math.sin(dx * 2.3 + seed) + 0.12 * Math.sin(dy * 2.9 + seed * 1.7) + 0.12 * Math.sin(dz * 2.6 + seed * 0.6)
        + 0.045 * Math.sin(dx * 6.1 + dz * 5.3 + seed * 2.3) + 0.035 * Math.sin(dy * 7.7 - dx * 4.9 + seed));
      let x = dx * k, y = dy * k, z = dz * k;
      // 平らな面：出っ張った部分を平面のほうへ押し戻して、割れ石らしい面を作る
      for (let p = 0; p < planes.length; p++) {
        const pl = planes[p];
        const e = x * pl[0] + y * pl[1] + z * pl[2] - pl[3];
        if (e > 0) { x -= pl[0] * e * 0.82; y -= pl[1] * e * 0.82; z -= pl[2] * e * 0.82; }
      }
      pos[i * 3] = x; pos[i * 3 + 1] = y * squash; pos[i * 3 + 2] = z;
    }
    // 面の法線を、重なっている頂点ごとに足し合わせて平均する
    const acc = new Float32Array(t.unique * 3);
    for (let f = 0; f < n; f += 3) {
      const a = f * 3, b = a + 3, c = a + 6;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (let k = 0; k < 3; k++) {
        const id = t.ids[f + k] * 3;
        acc[id] += nx; acc[id + 1] += ny; acc[id + 2] += nz;
      }
    }
    for (let i = 0; i < n; i++) {
      const id = t.ids[i] * 3;
      const l = Math.hypot(acc[id], acc[id + 1], acc[id + 2]) || 1;
      nor[i * 3] = acc[id] / l; nor[i * 3 + 1] = acc[id + 1] / l; nor[i * 3 + 2] = acc[id + 2] / l;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(t.uv), 2));
    return g;
  }

  // 丸太：軸が y。断面をいびつにし、軸もわずかに曲げる。側面（side）と切り口（caps）を別の形状で返す
  function logGeometry(THREE, len, r0, r1, rnd, o) {
    o = o || {};
    const radial = o.radial || 20, rings = o.rings || 10;
    const bend = o.bend !== undefined ? o.bend : 0.012;
    const rough = o.rough !== undefined ? o.rough : 1;
    const flare = o.flare || 0; // 根張り（幹の根元を太らせる）
    const p1 = rnd() * 6.28, p2 = rnd() * 6.28, p3 = rnd() * 6.28, bp = rnd() * 6.28;
    const rep = o.repeat || 1;
    const ts = [0, 0.02];
    for (let j = 1; j < rings; j++) ts.push(j / rings);
    ts.push(0.98, 1);
    const radiusAt = (a, t) => {
      const chamfer = (t === 0 || t === 1) ? 0.9 : 1;
      const base = (r0 + (r1 - r0) * t) * (1 + flare * Math.exp(-t * len / 0.28));
      return base * chamfer * (1 + rough * (0.06 * Math.sin(2 * a + p1 + t * 2.1) + 0.04 * Math.sin(3 * a + p2 - t * 3.3) + 0.025 * Math.sin(5 * a + p3 + t * 9)));
    };
    const axisAt = (t) => [bend * Math.sin(Math.PI * t + bp) * len, (t - 0.5) * len, bend * Math.cos(Math.PI * t * 1.3 + bp) * len];
    const rMean = (r0 + r1) / 2;
    const pos = [], uv = [], idx = [];
    for (let j = 0; j < ts.length; j++) {
      const t = ts[j], ax = axisAt(t);
      for (let i = 0; i <= radial; i++) {
        const a = (i / radial) * Math.PI * 2;
        const r = radiusAt(a, t);
        pos.push(ax[0] + Math.cos(a) * r, ax[1], ax[2] + Math.sin(a) * r);
        uv.push((i / radial) * rep, (t * len) / (2 * Math.PI * rMean) * rep);
      }
    }
    const w = radial + 1;
    for (let j = 0; j < ts.length - 1; j++) {
      for (let i = 0; i < radial; i++) {
        const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const side = new THREE.BufferGeometry();
    side.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    side.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    side.setIndex(idx);
    side.computeVertexNormals();
    // 継ぎ目（i = 0 と i = radial）の法線をそろえる
    const nor = side.attributes.normal;
    for (let j = 0; j < ts.length; j++) {
      const a = j * w, b = a + radial;
      const nx = nor.getX(a) + nor.getX(b), ny = nor.getY(a) + nor.getY(b), nz = nor.getZ(a) + nor.getZ(b);
      const l = Math.hypot(nx, ny, nz) || 1;
      nor.setXYZ(a, nx / l, ny / l, nz / l);
      nor.setXYZ(b, nx / l, ny / l, nz / l);
    }
    // 切り口：中心をわずかにふくらませる
    const cpos = [], cuv = [], cidx = [];
    [0, 1].forEach((t) => {
      const ax = axisAt(t), base = cpos.length / 3, sgn = t === 0 ? -1 : 1;
      cpos.push(ax[0], ax[1] + sgn * 0.004, ax[2]);
      cuv.push(0.5, 0.5);
      for (let i = 0; i <= radial; i++) {
        const a = (i / radial) * Math.PI * 2;
        const r = radiusAt(a, t);
        cpos.push(ax[0] + Math.cos(a) * r, ax[1], ax[2] + Math.sin(a) * r);
        cuv.push(0.5 + Math.cos(a) * 0.47, 0.5 + Math.sin(a) * 0.47);
      }
      for (let i = 0; i < radial; i++) {
        if (t === 0) cidx.push(base, base + 1 + i, base + 2 + i);
        else cidx.push(base, base + 2 + i, base + 1 + i);
      }
    });
    const caps = new THREE.BufferGeometry();
    caps.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3));
    caps.setAttribute('uv', new THREE.Float32BufferAttribute(cuv, 2));
    caps.setIndex(cidx);
    caps.computeVertexNormals();
    return { side, caps };
  }

  // 2 点 a → b に丸太（軸 y）を渡すための行列
  function alongMatrix(THREE, a, b, roll) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    dir.normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(up, roll || 0));
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    return { matrix: new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)), length: len };
  }

  /* ================================================================ */
  /* テクスチャ（すべて手続き生成）                                    */
  /* ================================================================ */

  function finishTexture(THREE, canvas, renderer, o) {
    o = o || {};
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = o.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    if (o.srgb) tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = Math.min(o.aniso || 8, renderer.capabilities.getMaxAnisotropy());
    return tex;
  }

  // 地面：踏み固めた土に、小石・落ち葉のかけら・松葉が散る。色と法線の 2 枚
  function groundTextures(THREE, renderer, rnd) {
    const N = 1024, M = 512;
    // 粗いむらは小さく作って引き伸ばし、細かい粒は 512 の模様を 2 回繰り返す
    const base = upsample(fbmTile(256, 4, 6, rnd, 0.55), 256, N);
    const gritM = fbmTile(M, 64, 3, rnd, 0.6);
    const hgt = new Float32Array(N * N);
    const c = newCanvas(N, N);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const b = base[i];
        const g = gritM[(y % M) * M + (x % M)];
        const k = smooth(0.3, 0.72, b);
        const tone = 0.72 + 0.5 * g;
        img.data[i * 4] = lerp(58, 112, k) * tone;
        img.data[i * 4 + 1] = lerp(45, 90, k) * tone;
        img.data[i * 4 + 2] = lerp(34, 68, k) * tone;
        img.data[i * 4 + 3] = 255;
        hgt[i] = b * 0.9 + g * 0.35;
      }
    }
    ctx.putImageData(img, 0, 0);
    // 端をまたぐものは反対側にも描いて、継ぎ目なく繰り返せるようにする
    const wrapDraw = (x, y, r, fn) => {
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const xx = x + ox * N, yy = y + oy * N;
        if (xx + r < 0 || xx - r > N || yy + r < 0 || yy - r > N) continue;
        fn(xx, yy);
      }
    };
    // 落ち葉・木くずのかけら（暗い斑点）
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * N, y = rnd() * N, r = 1.5 + rnd() * 5, a = rnd() * Math.PI;
      const shade = 22 + rnd() * 40;
      ctx.fillStyle = 'rgba(' + (shade + 18 | 0) + ',' + (shade | 0) + ',' + (shade * 0.6 | 0) + ',' + (0.35 + rnd() * 0.4) + ')';
      wrapDraw(x, y, r * 2, (xx, yy) => {
        ctx.beginPath();
        ctx.ellipse(xx, yy, r, r * (0.35 + rnd() * 0.4), a, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    // 小石：土に半ば埋もれた砂利。色は土に近い灰〜黄土で、高さはドーム状に盛る
    for (let i = 0; i < 900; i++) {
      const x = rnd() * N, y = rnd() * N;
      const r = 1.2 + Math.pow(rnd(), 3.2) * 8;
      const e = 0.6 + rnd() * 0.4, a = rnd() * Math.PI;
      const g = 74 + rnd() * 52, warm = 6 + rnd() * 22;
      const ca = Math.cos(a), sa = Math.sin(a);
      wrapDraw(x, y, r, (xx, yy) => {
        ctx.fillStyle = 'rgba(' + (g + warm | 0) + ',' + (g + warm * 0.45 | 0) + ',' + (g * 0.92 | 0) + ',0.85)';
        ctx.beginPath();
        ctx.ellipse(xx, yy, r, r * e, a, 0, Math.PI * 2);
        ctx.fill();
      });
      const hh = 0.35 + r * 0.14;
      const R = Math.ceil(r);
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const u = (dx * ca + dy * sa) / r, w = (-dx * sa + dy * ca) / (r * e);
        const q = 1 - u * u - w * w;
        if (q <= 0) continue;
        const o = (((Math.round(y) + dy) % N + N) % N) * N + ((Math.round(x) + dx) % N + N) % N;
        hgt[o] = Math.max(hgt[o], 0.6 + hh * Math.sqrt(q));
      }
    }
    // 松葉：赤茶の細い線
    ctx.lineCap = 'round';
    for (let i = 0; i < 5200; i++) {
      const x = rnd() * N, y = rnd() * N, a = rnd() * Math.PI * 2, l = 7 + rnd() * 13;
      const t = rnd();
      ctx.strokeStyle = 'rgba(' + (120 + t * 60 | 0) + ',' + (68 + t * 44 | 0) + ',' + (30 + t * 24 | 0) + ',' + (0.5 + rnd() * 0.4) + ')';
      ctx.lineWidth = 0.7 + rnd() * 0.7;
      wrapDraw(x, y, l, (xx, yy) => {
        ctx.beginPath();
        ctx.moveTo(xx, yy);
        ctx.lineTo(xx + Math.cos(a) * l, yy + Math.sin(a) * l);
        ctx.stroke();
      });
    }
    return {
      map: finishTexture(THREE, c, renderer, { srgb: true, aniso: 16 }),
      normalMap: finishTexture(THREE, normalCanvas(hgt, N, 2.2), renderer, { aniso: 16 }),
    };
  }

  // 石：灰色の地に、粒と淡い斑。細かなざらつきを法線に
  function stoneTextures(THREE, renderer, rnd) {
    const N = 512;
    const base = upsample(fbmTile(256, 4, 6, rnd, 0.55), 256, N);
    const fine = fbmTile(N, 64, 3, rnd, 0.6);
    const c = newCanvas(N, N);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    const hgt = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const v = 108 + (base[i] - 0.5) * 80 + (fine[i] - 0.5) * 46;
      img.data[i * 4] = v * 1.02; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 0.95; img.data[i * 4 + 3] = 255;
      hgt[i] = base[i] * 1.6 + fine[i] * 0.8;
    }
    ctx.putImageData(img, 0, 0);
    for (let i = 0; i < 5000; i++) {
      const x = rnd() * N, y = rnd() * N, r = 0.5 + rnd() * 1.4, dark = rnd() < 0.6;
      ctx.fillStyle = dark ? 'rgba(30,30,32,' + (0.25 + rnd() * 0.45) + ')' : 'rgba(215,210,200,' + (0.2 + rnd() * 0.4) + ')';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    return {
      map: finishTexture(THREE, c, renderer, { srgb: true }),
      normalMap: finishTexture(THREE, normalCanvas(hgt, N, 3.0), renderer),
    };
  }

  // 樹皮：縦に長い畝と溝。ところどころ横にひびが入る。色と法線
  function barkTextures(THREE, renderer, rnd) {
    const N = 512;
    // u（幹の周方向）に細かく、v（幹の軸方向）に長く伸びたノイズ
    const ridgeN = fbmTile(N, 28, 4, rnd, 0.55, 3);
    const fine = fbmTile(N, 64, 3, rnd, 0.6, 16);
    const tone = upsample(fbmTile(128, 4, 4, rnd, 0.5), 128, N);
    const wS = worleyTile(256, 10, 14, rnd);
    const w = { f1: upsample(wS.f1, 256, N), f2: upsample(wS.f2, 256, N) };
    const c = newCanvas(N, N);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    const hgt = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const ridge = 1 - Math.abs(2 * ridgeN[i] - 1);           // 畝：ノイズの中ほどが山になる
      const crack = smooth(0.0, 0.07, w.f2[i] - w.f1[i]);      // 横のひび
      const up = smooth(0.2, 0.8, ridge) * (0.8 + 0.2 * crack);
      const k = (0.8 + 0.4 * tone[i]) * (0.82 + 0.36 * fine[i]);
      img.data[i * 4] = lerp(26, 98, up) * k;
      img.data[i * 4 + 1] = lerp(20, 80, up) * k;
      img.data[i * 4 + 2] = lerp(16, 66, up) * k;
      img.data[i * 4 + 3] = 255;
      hgt[i] = up * 2.2 + fine[i] * 0.5;
    }
    ctx.putImageData(img, 0, 0);
    return {
      map: finishTexture(THREE, c, renderer, { srgb: true }),
      normalMap: finishTexture(THREE, normalCanvas(hgt, N, 2.4), renderer),
    };
  }

  // 炭化した薪：亀甲状に割れた黒い炭に、白い灰。割れ目の奥が赤く熾る（emissive）
  function charTextures(THREE, renderer, rnd) {
    const N = 512;
    const w = worleyTile(N, 16, 9, rnd);
    const fine = fbmTile(N, 16, 5, rnd, 0.6);
    const patch = upsample(fbmTile(128, 4, 4, rnd, 0.5), 128, N);
    const c = newCanvas(N, N), e = newCanvas(N, N);
    const ctx = c.getContext('2d'), ectx = e.getContext('2d');
    const img = ctx.createImageData(N, N), eimg = ectx.createImageData(N, N);
    const hgt = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const edge = w.f2[i] - w.f1[i];
      const plate = smooth(0.015, 0.16, edge);
      // 灰：一部の炭片の表面だけ白く粉をふく
      const ash = smooth(0.5, 0.75, patch[i] * 0.6 + w.id[i] * 0.4) * plate * (0.5 + 0.5 * fine[i]);
      const v = lerp(4, 22 + 20 * fine[i], plate);
      img.data[i * 4] = lerp(v, 150, ash * 0.85);
      img.data[i * 4 + 1] = lerp(v, 146, ash * 0.85);
      img.data[i * 4 + 2] = lerp(v, 142, ash * 0.85);
      img.data[i * 4 + 3] = 255;
      hgt[i] = plate * 2.6 + fine[i] * 0.5;
      // 熾：割れ目ほど強く、炭片の縁にもにじむ
      const glow = Math.pow(1 - smooth(0.0, 0.24, edge), 1.4) * (0.5 + 0.5 * fine[i]) + 0.05 * (1 - ash);
      const gv = clamp01(glow) * 255;
      eimg.data[i * 4] = gv; eimg.data[i * 4 + 1] = gv; eimg.data[i * 4 + 2] = gv; eimg.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    ectx.putImageData(eimg, 0, 0);
    return {
      map: finishTexture(THREE, c, renderer, { srgb: true }),
      normalMap: finishTexture(THREE, normalCanvas(hgt, N, 3.0), renderer),
      emissiveMap: finishTexture(THREE, e, renderer),
    };
  }

  // 切り口：年輪と放射状のひび
  function endGrainTexture(THREE, renderer, rnd) {
    const N = 256;
    const c = newCanvas(N, N);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#967650';
    ctx.fillRect(0, 0, N, N);
    const cx = N / 2 + (rnd() - 0.5) * 16, cy = N / 2 + (rnd() - 0.5) * 16;
    for (let r = 3; r < N * 0.75; r += 2.2 + rnd() * 3.2) {
      ctx.strokeStyle = 'rgba(96,66,40,' + (0.25 + rnd() * 0.4) + ')';
      ctx.lineWidth = 0.8 + rnd() * 1.6;
      ctx.beginPath();
      for (let a = 0; a <= 64; a++) {
        const an = (a / 64) * Math.PI * 2;
        const rr = r * (1 + 0.035 * Math.sin(an * 3 + r * 0.05) + 0.02 * Math.sin(an * 7 + r * 0.11));
        const x = cx + Math.cos(an) * rr, y = cy + Math.sin(an) * rr;
        if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    const heart = ctx.createRadialGradient(cx, cy, 2, cx, cy, N * 0.3);
    heart.addColorStop(0, 'rgba(110,70,40,0.55)');
    heart.addColorStop(1, 'rgba(110,70,40,0)');
    ctx.fillStyle = heart;
    ctx.fillRect(0, 0, N, N);
    for (let i = 0; i < 7; i++) {
      const an = rnd() * Math.PI * 2, l = N * (0.15 + rnd() * 0.3);
      ctx.strokeStyle = 'rgba(40,26,16,' + (0.4 + rnd() * 0.4) + ')';
      ctx.lineWidth = 0.8 + rnd() * 1.4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(an) * 4, cy + Math.sin(an) * 4);
      ctx.lineTo(cx + Math.cos(an + (rnd() - 0.5) * 0.2) * l, cy + Math.sin(an + (rnd() - 0.5) * 0.2) * l);
      ctx.stroke();
    }
    return finishTexture(THREE, c, renderer, { srgb: true, clamp: true });
  }

  // 針葉樹を 1 本描く。kind: 'spruce'（トウヒ・モミ）, 'pine'（マツ）, 'shrub'（下生え）
  function drawTree(ctx, W, H, rnd, kind, o) {
    o = o || {};
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    const cx = W / 2 + (rnd() - 0.5) * W * 0.04;
    const palette = [];
    for (let i = 0; i < 24; i++) palette.push('hsl(' + (88 + rnd() * 44 | 0) + ',' + (18 + rnd() * 22 | 0) + '%,' + (7 + rnd() * 11 | 0) + '%)');
    const green = () => palette[(rnd() * palette.length) | 0];
    const needles = (x, y, dirX, dirY, n, len, wid) => {
      for (let k = 0; k < n; k++) {
        const a = Math.atan2(dirY, dirX) + (rnd() - 0.5) * 1.5;
        const l = len * (0.5 + rnd() * 0.8);
        ctx.strokeStyle = green();
        ctx.lineWidth = wid * (0.7 + rnd() * 0.8);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
        ctx.stroke();
      }
    };
    if (kind === 'shrub') {
      for (let b = 0; b < 9; b++) {
        const bx = W * (0.12 + rnd() * 0.76), bh = H * (0.35 + rnd() * 0.6), br = W * (0.07 + rnd() * 0.09);
        for (let i = 0; i < 260; i++) {
          const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * br;
          const x = bx + Math.cos(a) * r * 1.3, y = H - bh * (0.15 + 0.85 * rnd()) + Math.sin(a) * r * 0.3;
          needles(x, y, rnd() - 0.5, -0.4 - rnd() * 0.6, 2, W * 0.035, W * 0.012);
        }
      }
      return;
    }
    const sc = H / 512;
    const trunkW = W * (kind === 'pine' ? 0.05 : 0.04);
    const top = H * 0.015;
    // 幹：根元から梢へ細くなる
    const tg = ctx.createLinearGradient(0, H, 0, top);
    tg.addColorStop(0, '#2a1d14');
    tg.addColorStop(1, '#17100b');
    ctx.fillStyle = tg;
    const lean = (rnd() - 0.5) * W * 0.05;
    const axisX = (y) => cx + lean * Math.pow(1 - (y - top) / (H - top), 2);
    ctx.beginPath();
    ctx.moveTo(axisX(H) - trunkW * 0.7, H);
    ctx.lineTo(axisX(top) - 0.6, top);
    ctx.lineTo(axisX(top) + 0.6, top);
    ctx.lineTo(axisX(H) + trunkW * 0.7, H);
    ctx.closePath();
    ctx.fill();
    if (kind === 'pine') {
      // マツ：高い幹の上のほうに、枝先の葉のかたまりが散る
      const limbs = 11 + (rnd() * 6 | 0);
      for (let i = 0; i < limbs; i++) {
        const t = Math.pow(rnd(), 1.4);
        const y0 = top + (H * 0.52) * t + H * 0.02;
        const side = rnd() < 0.5 ? -1 : 1;
        const len = W * (0.1 + 0.3 * t) * (0.6 + rnd() * 0.6);
        const x0 = axisX(y0), x1 = x0 + side * len, y1 = y0 - len * (0.15 + rnd() * 0.5);
        ctx.strokeStyle = '#1f150e';
        ctx.lineWidth = Math.max(1, trunkW * 0.28 * (0.4 + t));
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(x0 + side * len * 0.5, y0 + len * 0.08, x1, y1);
        ctx.stroke();
        const clumps = 2 + (rnd() * 3 | 0);
        for (let c = 0; c < clumps; c++) {
          const px = lerp(x0 + side * len * 0.45, x1, rnd()) + (rnd() - 0.5) * len * 0.3;
          const py = lerp(y0, y1, rnd()) - rnd() * len * 0.25;
          const rr = W * (0.05 + rnd() * 0.06);
          for (let k = 0; k < 70; k++) {
            const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * rr;
            needles(px + Math.cos(a) * r * 1.35, py + Math.sin(a) * r * 0.7, Math.cos(a), -0.3 + Math.sin(a) * 0.5, 2, 9 * sc, 1.6 * sc);
          }
        }
      }
      return;
    }
    // トウヒ・モミ：梢から裾へ段々に広がる枝。枝は垂れ、先だけ少し上を向く
    const crownBot = H * (1 - (o.skirt !== undefined ? o.skirt : 0.1));
    const halfW = W * (o.width !== undefined ? o.width : 0.42);
    const levels = o.levels || 36;
    const droop = o.droop !== undefined ? o.droop : 0.42;
    // 芯の詰まった部分（幹まわり）を先に塗って、中が透けないようにする
    ctx.fillStyle = '#0d120b';
    ctx.beginPath();
    ctx.moveTo(axisX(top), top);
    for (let i = 0; i <= 24; i++) {
      const t = i / 24, y = lerp(top, crownBot, t);
      ctx.lineTo(axisX(y) + halfW * 0.45 * Math.pow(t, 0.85) * (0.75 + 0.5 * rnd()), y);
    }
    for (let i = 24; i >= 0; i--) {
      const t = i / 24, y = lerp(top, crownBot, t);
      ctx.lineTo(axisX(y) - halfW * 0.45 * Math.pow(t, 0.85) * (0.75 + 0.5 * rnd()), y);
    }
    ctx.closePath();
    ctx.fill();
    for (let i = 0; i < levels; i++) {
      const t = (i + rnd() * 0.6) / levels;
      const y = lerp(top + H * 0.01, crownBot, Math.pow(t, 0.92));
      const reach = halfW * (0.05 + 0.95 * Math.pow(t, 0.8));
      for (let side = -1; side <= 1; side += 2) {
        if (rnd() < 0.07) continue;
        const len = reach * (0.7 + 0.45 * rnd());
        const dr = len * droop * (0.6 + 0.8 * rnd());
        const steps = Math.max(3, Math.round(len / (4.5 * sc)));
        const x0 = axisX(y);
        for (let s = 0; s <= steps; s++) {
          const u = s / steps;
          const bx = x0 + side * len * u;
          const by = y + dr * (u * u * 1.25 - 0.25 * u * u * u * u * 1.6);
          needles(bx, by, side * 0.55, 0.85, 4, (11 - 5 * u) * sc * (0.7 + 0.6 * t), 1.7 * sc);
        }
      }
    }
  }

  // モミの枝 1 本（幹に近い側が左）。近くの木の下枝に貼る
  function boughTexture(THREE, renderer, rnd) {
    const W = 256, H = 128;
    const c = newCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.lineCap = 'round';
    const green = () => 'hsl(' + (90 + rnd() * 40 | 0) + ',' + (20 + rnd() * 20 | 0) + '%,' + (9 + rnd() * 13 | 0) + '%)';
    const twig = (x0, y0, a, len, depth) => {
      const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len;
      ctx.strokeStyle = '#231710';
      ctx.lineWidth = Math.max(0.8, 3.2 - depth * 1.1);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      const n = Math.round(len / 2.2);
      for (let i = 0; i <= n; i++) {
        const u = i / n, px = lerp(x0, x1, u), py = lerp(y0, y1, u);
        for (let s = -1; s <= 1; s += 2) {
          const na = a + s * (0.9 + rnd() * 0.5);
          const l = 5 + rnd() * 5;
          ctx.strokeStyle = green();
          ctx.lineWidth = 0.9 + rnd() * 0.8;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + Math.cos(na) * l, py + Math.sin(na) * l + 1.5);
          ctx.stroke();
        }
      }
      if (depth < 2) {
        const kids = depth === 0 ? 9 : 3;
        for (let k = 0; k < kids; k++) {
          const u = 0.12 + 0.8 * (k + rnd() * 0.6) / kids;
          const s = k % 2 === 0 ? -1 : 1;
          twig(lerp(x0, x1, u), lerp(y0, y1, u), a + s * (0.45 + rnd() * 0.35), len * (0.42 - 0.2 * u) * (0.8 + rnd() * 0.5), depth + 1);
        }
      }
    };
    twig(2, H * 0.46, 0.06, W * 0.93, 0);
    return finishTexture(THREE, c, renderer, { srgb: true, clamp: true });
  }

  // 木立の樹種（板 1 枚ぶんの絵）
  const TREE_KINDS = [
    ['spruce', { width: 0.4, droop: 0.42, skirt: 0.07, levels: 38 }],
    ['spruce', { width: 0.3, droop: 0.55, skirt: 0.16, levels: 34 }],
    ['spruce', { width: 0.46, droop: 0.32, skirt: 0.05, levels: 40 }],
    ['pine', {}],
    ['spruce', { width: 0.24, droop: 0.6, skirt: 0.22, levels: 30 }],
  ];

  // テクスチャ一式。作るのに時間がかかるので、一度作ったら保持してシーンに戻ったときに使い回す
  // （シーンを離れると GPU 側は app が解放するが、元の Canvas は残り、次に使うとき自動で送り直される）。
  // 配置用とは別の乱数列を使うので、保持の有無で景色は変わらない
  let textureCache = null;
  function textureSet(THREE, renderer) {
    if (textureCache) return textureCache;
    const t = {};
    t.ground = groundTextures(THREE, renderer, makeRng(101));
    t.stone = stoneTextures(THREE, renderer, makeRng(102));
    t.bark = barkTextures(THREE, renderer, makeRng(103));
    t.char = charTextures(THREE, renderer, makeRng(104));
    t.endGrain = endGrainTexture(THREE, renderer, makeRng(105));
    t.bough = boughTexture(THREE, renderer, makeRng(106));
    const treeRnd = makeRng(107);
    t.trees = TREE_KINDS.map((k) => {
      const c = newCanvas(256, 512);
      drawTree(c.getContext('2d'), 256, 512, treeRnd, k[0], k[1]);
      return finishTexture(THREE, c, renderer, { srgb: true, clamp: true, aniso: 4 });
    });
    const shrubCanvas = newCanvas(256, 128);
    drawTree(shrubCanvas.getContext('2d'), 256, 128, treeRnd, 'shrub');
    t.shrub = finishTexture(THREE, shrubCanvas, renderer, { srgb: true, clamp: true, aniso: 4 });
    textureCache = t;
    return t;
  }

  /* ================================================================ */
  /* シーン                                                            */
  /* ================================================================ */

  madobe.register({
    id: 'campfire',
    name: '焚き火',
    meta: 'fire · night · forest',
    params: [
      { key: 'power',  label: '火の勢い', min: 0.2, max: 2,   step: 0.1, value: 1 },
      { key: 'wind',   label: '風',       min: -4,  max: 4,   step: 0.5, value: 0.5 },
      { key: 'embers', label: '火の粉',   min: 0,   max: 400, step: 20,  value: 160 },
      { key: 'smoke',  label: '煙',       min: 0,   max: 160, step: 10,  value: 70 },
    ],

    create({ THREE, renderer, scene, camera, reduceMotion, helpers }) {
      const rnd = makeRng(20261114);
      // 指で操作する端末（スマホ・タブレット）は軽めの設定にする：影のぼかしの点数、流体の格子、星の数
      const lite = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      renderer.shadowMap.enabled = true;
      // 光は距離の 2 乗で弱まる（物理的な減衰）。炎のそばだけが明るく、少し離れると闇に沈む
      renderer.physicallyCorrectLights = true;
      // HDR のまま RT に描き、トーンマッピングは makePost の合成パスで掛ける（app 側が切替時に戻す）
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1.0;

      const fogColor = new THREE.Color(0.006, 0.01, 0.018);
      scene.background = fogColor.clone();
      scene.fog = new THREE.FogExp2(fogColor.getHex(), 0.011);
      scene.fog.color.copy(fogColor);

      camera.near = 0.1;
      camera.far = 700;
      camera.updateProjectionMatrix();
      const camBase = new THREE.Vector3(0, 1.25, 4.7);
      const camAim = new THREE.Vector3(0, 1.0, 0);
      camera.position.copy(camBase);
      camera.lookAt(camAim);

      const owned = []; // シーンに属さない（自前で解放する）もの
      const noiseTex = helpers.makeNoiseTexture(THREE);
      owned.push(noiseTex);
      const uTime = { value: 0 };
      const uGlow = { value: 1 };

      /* ---------------- 地面 ---------------- */
      // ゆるい起伏。焚き火のまわりは平らにして、石や薪が浮かないようにする
      const groundHeight = (x, z) => {
        const r = Math.hypot(x, z);
        const fade = smooth(0.95, 2.6, r) * (1 - smooth(11, 15, r));
        if (fade <= 0) return 0;
        const n1 = Math.sin(x * 0.83 + 1.3) * Math.cos(z * 0.71 - 0.4) + 0.6 * Math.sin(x * 1.7 - z * 1.3 + 2.1);
        const n2 = Math.sin(x * 3.9 + z * 2.7) + Math.sin(x * 2.3 - z * 4.6 + 1.1);
        return fade * (0.045 * n1 + 0.012 * n2);
      };
      const tex = textureSet(THREE, renderer);
      const gTex = tex.ground;
      const TILE = 3.2; // テクスチャ 1 枚ぶんの実寸（m）
      {
        const radii = [0];
        for (let k = 1; k <= 96; k++) radii.push(13 * Math.pow(k / 96, 1.35));
        radii.push(17, 24, 36, 60, 110, 220);
        const seg = 128;
        const pos = [], uv = [], idx = [];
        for (let j = 0; j < radii.length; j++) {
          for (let i = 0; i <= seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            const x = Math.cos(a) * radii[j], z = Math.sin(a) * radii[j];
            pos.push(x, groundHeight(x, z), z);
            uv.push(x / TILE, z / TILE);
          }
        }
        const w = seg + 1;
        for (let j = 0; j < radii.length - 1; j++) {
          for (let i = 0; i < seg; i++) {
            const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
            idx.push(a, b, c, b, d, c);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({
          map: gTex.map, normalMap: gTex.normalMap, normalScale: new THREE.Vector2(1.1, 1.1), roughness: 0.97, metalness: 0,
        });
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.uNoiseTex = { value: noiseTex };
          injectWorldPos(shader);
          softPointShadows(THREE, shader, lite ? 8 : 16);
          shader.fragmentShader = 'uniform sampler2D uNoiseTex;\n' + shader.fragmentShader.replace(
            '#include <map_fragment>',
            `#include <map_fragment>
             {
               // 繰り返しを目立たなくする大きなむら（湿り・踏み跡）
               float gv = texture2D(uNoiseTex, vWp.xz * 0.041).r;
               float gv2 = texture2D(uNoiseTex, vWp.xz * 0.19 + 0.37).g;
               diffuseColor.rgb *= 0.62 + 0.7 * mix(gv, gv2, 0.45);
               // 焚き火のまわりは灰と煤で黒ずむ
               float rr = length(vWp.xz);
               float scorch = (1.0 - smoothstep(0.75, 1.7, rr)) * (0.55 + 0.45 * gv2);
               diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.046, 0.043), scorch * 0.8);
             }`);
        };
        mat.customProgramCacheKey = () => 'madobe-campfire-ground-' + (lite ? 8 : 16);
        const ground = new THREE.Mesh(geo, mat);
        ground.receiveShadow = true;
        scene.add(ground);
      }

      /* ---------------- 焚き火：石の囲い ---------------- */
      const sTex = tex.stone;
      const stoneMat = new THREE.MeshStandardMaterial({
        map: sTex.map, normalMap: sTex.normalMap, normalScale: new THREE.Vector2(1.6, 1.6),
        roughness: 0.9, metalness: 0, vertexColors: true,
      });
      stoneMat.onBeforeCompile = (shader) => { capDirectLight(THREE, shader, 16); };
      stoneMat.customProgramCacheKey = () => 'madobe-campfire-stone';
      {
        const items = [];
        const count = 12;
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2 + (rnd() - 0.5) * 0.2 + 0.13;
          const rad = 0.125 + rnd() * 0.075;
          const squash = 0.62 + rnd() * 0.24;
          const R = 0.8 + (rnd() - 0.5) * 0.1;
          const geo = rockGeometry(THREE, rad, 6, rnd, squash);
          const m = new THREE.Matrix4().compose(
            new THREE.Vector3(Math.cos(a) * R, rad * squash * 0.72, Math.sin(a) * R),
            new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.3, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.3)),
            new THREE.Vector3(1, 1, 1));
          geo.applyMatrix4(m);
          // 煤：火のほうを向いた面ほど黒い。地面との境は暗く沈める
          const pos = geo.attributes.position, nor = geo.attributes.normal;
          const col = new Float32Array(pos.count * 3);
          const tint = 0.5 + rnd() * 0.6, warm = 0.95 + rnd() * 0.13;
          for (let k = 0; k < pos.count; k++) {
            const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
            const l = Math.hypot(x, z) || 1;
            const facing = -(nor.getX(k) * x + nor.getZ(k) * z) / l;
            const soot = smooth(-0.1, 0.8, facing) * (0.55 + 0.45 * smooth(0.3, 0.0, y));
            const ao = 0.45 + 0.55 * smooth(0.0, 0.06, y);
            const v = tint * lerp(1, 0.22, soot) * ao;
            col[k * 3] = v * warm; col[k * 3 + 1] = v; col[k * 3 + 2] = v * (2 - warm);
          }
          geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
          items.push({ geometry: geo });
        }
        const stones = new THREE.Mesh(mergeGeometries(THREE, items), stoneMat);
        stones.castShadow = true;
        stones.receiveShadow = true;
        scene.add(stones);
      }

      /* ---------------- 焚き火：灰の床と熾 ---------------- */
      // 熾の光り方：位置から決まるむら（熱い筋と灰をかぶった面）が、ゆっくり息をするように明滅する
      const emberChunk = `
        {
          vec3 q = vWp * 9.0;
          float n1 = texture2D(uNoiseTex, q.xz * 0.11 + q.y * 0.07).r;
          float n2 = texture2D(uNoiseTex, q.xz * 0.37 + vec2(q.y * 0.21, 0.5)).g;
          float breathe = texture2D(uNoiseTex, vWp.xz * 0.9 + vec2(uTime * 0.021, uTime * 0.033)).b;
          float rr = length(vWp.xz);
          // 上を向いた面は灰をかぶって暗く、すき間や下面ほど熱い
          vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float crust = smoothstep(0.1, 0.9, dot(normal, upV));
          float heat = (0.15 + 1.25 * n1 * n1) * (0.5 + 1.0 * breathe) * (1.0 - smoothstep(0.16, 0.44, rr)) * uEmber;
          heat *= (0.45 + 0.9 * smoothstep(0.3, 0.7, n2)) * (1.0 - 0.55 * crust) * uGlow;
          vec3 hot = mix(vec3(1.0, 0.06, 0.0), vec3(1.0, 0.2, 0.015), smoothstep(0.3, 0.8, heat));
          hot = mix(hot, vec3(1.0, 0.45, 0.08), smoothstep(0.8, 1.35, heat));
          totalEmissiveRadiance += hot * smoothstep(0.12, 0.45, heat) * (0.2 + 2.4 * heat * heat);
          // 熱いところは灰が飛んで地の色が見えにくい
          diffuseColor.rgb *= 1.0 - 0.6 * smoothstep(0.3, 0.9, heat);
        }`;
      const makeEmberMaterial = (color, ember, key) => {
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, vertexColors: true });
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.uNoiseTex = { value: noiseTex };
          shader.uniforms.uTime = uTime;
          shader.uniforms.uGlow = uGlow;
          shader.uniforms.uEmber = { value: ember };
          injectWorldPos(shader);
          capDirectLight(THREE, shader, 5);
          shader.fragmentShader = 'uniform sampler2D uNoiseTex;\nuniform float uTime;\nuniform float uGlow;\nuniform float uEmber;\n'
            + shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + emberChunk);
        };
        mat.customProgramCacheKey = () => 'madobe-campfire-ember-' + key;
        return mat;
      };
      {
        // 灰の床：中心が少し盛り上がった円盤
        const rings = 20, seg = 64;
        const pos = [], col = [], idx = [];
        const bedR = 0.72;
        const bedY = (x, z) => {
          const r = Math.hypot(x, z);
          return 0.006 + 0.055 * Math.exp(-(r * r) / 0.09) + 0.006 * Math.sin(x * 23 + z * 17) * Math.cos(z * 29 - x * 11);
        };
        const uvs = [];
        const ashAt = (x, z) => {
          // 中心は白っぽい灰、外へ行くほど黒い燃えかす。細かなむらを重ねる
          const r = Math.hypot(x, z);
          const s1 = 0.5 + 0.5 * Math.sin(x * 31 + z * 7) * Math.sin(z * 37 - x * 13);
          const s2 = 0.5 + 0.5 * Math.sin(x * 83 - z * 61 + 1.7) * Math.sin(z * 71 + x * 47);
          return lerp(0.62, 0.13, smooth(0.18, 0.62, r + (s1 - 0.5) * 0.18)) * (0.6 + 0.8 * s2 * s1);
        };
        pos.push(0, bedY(0, 0), 0); uvs.push(0, 0);
        { const v = ashAt(0, 0); col.push(v, v * 0.97, v * 0.93); }
        for (let j = 1; j <= rings; j++) {
          const r = bedR * j / rings;
          for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            const x = Math.cos(a) * r, z = Math.sin(a) * r;
            pos.push(x, bedY(x, z), z);
            uvs.push(x / 0.45, z / 0.45);
            const v = ashAt(x, z);
            col.push(v, v * 0.97, v * 0.93);
          }
        }
        for (let i = 0; i < seg; i++) idx.push(0, 1 + (i + 1) % seg, 1 + i);
        for (let j = 1; j < rings; j++) {
          for (let i = 0; i < seg; i++) {
            const a = 1 + (j - 1) * seg + i, b = 1 + (j - 1) * seg + (i + 1) % seg, c = a + seg, d = b + seg;
            idx.push(a, b, c, b, d, c);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        const bedMat = makeEmberMaterial(0xffffff, 0.75, 'bed');
        bedMat.map = sTex.map;
        bedMat.normalMap = gTex.normalMap;
        bedMat.normalScale = new THREE.Vector2(1.6, 1.6);
        const bed = new THREE.Mesh(geo, bedMat);
        bed.receiveShadow = true;
        scene.add(bed);

        // 熾：いびつな炭のかけらを中心に積む
        const lumpGeo = rockGeometry(THREE, 1, 2, rnd, 0.8);
        const lcol = new Float32Array(lumpGeo.attributes.position.count * 3).fill(1);
        lumpGeo.setAttribute('color', new THREE.BufferAttribute(lcol, 3));
        const lumps = 120;
        const coals = new THREE.InstancedMesh(lumpGeo, makeEmberMaterial(0x23201e, 1.25, 'coal'), lumps);
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
        for (let i = 0; i < lumps; i++) {
          // 3 分の 2 は中心に積もる熾、残りは外側に散った消し炭（熱くないので光らない）
          const inner = i < 80;
          const a = rnd() * Math.PI * 2, r = inner ? Math.pow(rnd(), 0.7) * 0.36 : 0.3 + rnd() * 0.34;
          const s = inner ? 0.02 + rnd() * 0.034 : 0.01 + rnd() * 0.022;
          p.set(Math.cos(a) * r, bedY(Math.cos(a) * r, Math.sin(a) * r) + s * 0.4 + (inner ? rnd() * 0.022 * (1 - r / 0.36) : 0), Math.sin(a) * r);
          q.setFromEuler(new THREE.Euler(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28));
          sc.set(s * (0.8 + rnd() * 0.7), s * (0.6 + rnd() * 0.5), s * (0.8 + rnd() * 0.7));
          coals.setMatrixAt(i, m.compose(p, q, sc));
        }
        coals.instanceMatrix.needsUpdate = true;
        coals.frustumCulled = false;
        scene.add(coals);
      }

      /* ---------------- 焚き火：薪 ---------------- */
      const cTex = tex.char;
      const uLogHeat = { value: 1 };
      const charMat = new THREE.MeshStandardMaterial({
        map: cTex.map, normalMap: cTex.normalMap, normalScale: new THREE.Vector2(1.4, 1.4),
        emissiveMap: cTex.emissiveMap, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 1,
        roughness: 0.82, metalness: 0,
      });
      charMat.onBeforeCompile = (shader) => {
        shader.uniforms.uNoiseTex = { value: noiseTex };
        shader.uniforms.uTime = uTime;
        shader.uniforms.uLogHeat = uLogHeat;
        injectWorldPos(shader);
        capDirectLight(THREE, shader, 4);
        shader.fragmentShader = 'uniform sampler2D uNoiseTex;\nuniform float uTime;\nuniform float uLogHeat;\n'
          + shader.fragmentShader.replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>
             {
               // 割れ目の熾は、火の芯に近く低いところほど強い。全体がゆっくり息をする
               float rr = length(vWp.xz);
               float near = (1.0 - smoothstep(0.12, 0.52, rr)) * (1.0 - smoothstep(0.1, 0.6, vWp.y));
               float breathe = texture2D(uNoiseTex, vWp.xz * 1.3 + vWp.y * 0.6 + vec2(uTime * 0.027, -uTime * 0.019)).r;
               float spot = texture2D(uNoiseTex, vWp.xy * 2.1 + vWp.z * 1.3).g;
               float k = near * (0.3 + 1.3 * breathe) * smoothstep(0.2, 0.65, spot + near * 0.4) * uLogHeat;
               float h = totalEmissiveRadiance.r * k * 1.5;
               vec3 hot = mix(vec3(1.0, 0.06, 0.0), vec3(1.0, 0.2, 0.015), smoothstep(0.25, 0.7, h));
               hot = mix(hot, vec3(1.0, 0.45, 0.08), smoothstep(0.7, 1.2, h));
               totalEmissiveRadiance = hot * smoothstep(0.05, 0.3, h) * (0.15 + 2.6 * h * h);
             }`);
      };
      charMat.customProgramCacheKey = () => 'madobe-campfire-char';
      {
        const V = (x, y, z) => new THREE.Vector3(x, y, z);
        // [根元, 先端, 根元の半径, 先端の半径]。手前の 2 本が「ハ」の字に開き、奥の 2 本が寄りかかる
        const layout = [
          [V(-0.42, 0.055, 0.21), V(0.1, 0.5, -0.06), 0.056, 0.045],
          [V(0.44, 0.06, 0.15), V(-0.09, 0.47, -0.03), 0.06, 0.05],
          [V(0.13, 0.05, -0.45), V(-0.04, 0.53, 0.08), 0.05, 0.042],
          [V(-0.31, 0.05, -0.35), V(0.07, 0.44, 0.04), 0.05, 0.04],
          [V(-0.27, 0.085, -0.02), V(0.25, 0.09, -0.13), 0.062, 0.056],
          [V(-0.13, 0.05, 0.29), V(0.2, 0.06, 0.25), 0.04, 0.036],
        ];
        const items = [];
        layout.forEach((l) => {
          const pl = alongMatrix(THREE, l[0], l[1], rnd() * 6.28);
          const g = logGeometry(THREE, pl.length, l[2], l[3], rnd, { radial: 20, rings: 10, bend: 0.015, rough: 1.3 });
          items.push({ geometry: g.side, matrix: pl.matrix }, { geometry: g.caps, matrix: pl.matrix });
        });
        const logs = new THREE.Mesh(mergeGeometries(THREE, items), charMat);
        logs.receiveShadow = true; // 炎に包まれているので、薪自身は影を落とさない
        scene.add(logs);
      }

      /* ---------------- まわりの小物：小石・小枝・腰掛けの丸太・薪の山・切り株 ---------------- */
      const bTex = tex.bark;
      const barkMat = new THREE.MeshStandardMaterial({
        map: bTex.map, normalMap: bTex.normalMap, normalScale: new THREE.Vector2(1.5, 1.5), roughness: 0.95, metalness: 0, vertexColors: true,
      });
      const endMat = new THREE.MeshStandardMaterial({ map: tex.endGrain, color: 0x8c8780, roughness: 0.85, metalness: 0, vertexColors: true });
      const props = { bark: [], ends: [] };
      const addLog = (a, b, r0, r1, o) => {
        const pl = alongMatrix(THREE, a, b, rnd() * 6.28);
        const g = logGeometry(THREE, pl.length, r0, r1, rnd, o);
        [g.side, g.caps].forEach((geo) => {
          geo.applyMatrix4(pl.matrix);
          if (o && o.ao === false) return;
          // 地面に近いところほど暗くして、置かれている感じを出す
          const pos = geo.attributes.position;
          const col = new Float32Array(pos.count * 3);
          for (let k = 0; k < pos.count; k++) {
            const v = 0.3 + 0.7 * smooth(0.0, 0.11, pos.getY(k) - groundHeight(pos.getX(k), pos.getZ(k)));
            col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = v;
          }
          geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        });
        props.bark.push({ geometry: g.side, color: o && o.color });
        props.ends.push({ geometry: g.caps, color: o && o.endColor });
      };
      {
        const V = (x, y, z) => new THREE.Vector3(x, y + groundHeight(x, z), z);
        // 腰掛けの丸太：焚き火の左奥に、火へ横腹を向けて寝かせる
        addLog(V(-2.25, 0.165, -1.25), V(-0.75, 0.165, -2.3), 0.175, 0.16, { radial: 28, rings: 12, bend: 0.006, repeat: 1, rough: 0.8 });
        // 薪の山：右奥に 3・2・1 と積む。切り口が火のほうを向く
        const pile = new THREE.Vector3(2.15, 0, -1.2);
        const ax = new THREE.Vector3(-0.72, 0, 0.7).normalize(); // 薪の軸（切り口の向き）
        const sideways = new THREE.Vector3(ax.z, 0, -ax.x);
        const rows = [[-0.15, 0, 0.15], [-0.075, 0.075], [0]];
        rows.forEach((row, ri) => row.forEach((sx) => {
          const r = 0.062 + rnd() * 0.012;
          const c = pile.clone().addScaledVector(sideways, sx + (rnd() - 0.5) * 0.012);
          c.y = groundHeight(c.x, c.z) + 0.07 + ri * 0.125;
          const half = 0.2 + rnd() * 0.03, slide = (rnd() - 0.5) * 0.05;
          addLog(c.clone().addScaledVector(ax, -half + slide), c.clone().addScaledVector(ax, half + slide), r, r * (0.9 + rnd() * 0.15),
            { radial: 16, rings: 4, bend: 0.004, rough: 0.9, color: [0.95, 0.9, 0.85] });
        }));
        // 切り株：薪割りの台
        addLog(V(2.95, 0, -0.25), V(2.95, 0.4, -0.25), 0.24, 0.215, { radial: 28, rings: 6, bend: 0, flare: 0.22, repeat: 1, rough: 0.7 });
      }
      const pebbleItems = [];
      {
        // 小石：焚き火のまわりから外へ、まばらに。大きめの石も少し混ぜる
        for (let i = 0; i < 120; i++) {
          const a = rnd() * Math.PI * 2;
          const r = 1.05 + Math.pow(rnd(), 1.5) * 6.5;
          const x = Math.cos(a) * r, z = Math.sin(a) * r;
          if (Math.hypot(x + 1.5, z + 1.8) < 1.0 || Math.hypot(x - 2.3, z + 1.0) < 0.75) continue;
          const big = rnd() < 0.07;
          const s = big ? 0.07 + rnd() * 0.07 : 0.012 + Math.pow(rnd(), 2) * 0.045;
          const squash = 0.5 + rnd() * 0.35;
          const geo = rockGeometry(THREE, s, big ? 4 : 2, rnd, squash);
          const tint = 0.55 + rnd() * 0.6;
          const m = new THREE.Matrix4().compose(
            new THREE.Vector3(x, groundHeight(x, z) + s * squash * 0.55, z),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rnd() * 6.28, 0)), new THREE.Vector3(1, 1, 1));
          pebbleItems.push({ geometry: geo, matrix: m, color: [tint * (0.98 + rnd() * 0.08), tint, tint * (0.9 + rnd() * 0.08)] });
        }
        const pebbles = new THREE.Mesh(mergeGeometries(THREE, pebbleItems), stoneMat);
        pebbles.castShadow = true;
        pebbles.receiveShadow = true;
        scene.add(pebbles);
        // 小枝：地面に落ちた枯れ枝
        for (let i = 0; i < 46; i++) {
          const a = rnd() * Math.PI * 2;
          const r = 1.2 + Math.pow(rnd(), 1.3) * 6;
          const x = Math.cos(a) * r, z = Math.sin(a) * r;
          const len = 0.14 + rnd() * 0.5, yaw = rnd() * Math.PI * 2, rad = 0.004 + rnd() * 0.009;
          const dx = Math.cos(yaw) * len * 0.5, dz = Math.sin(yaw) * len * 0.5;
          const ya = groundHeight(x - dx, z - dz) + rad, yb = groundHeight(x + dx, z + dz) + rad + rnd() * 0.02;
          addLog(new THREE.Vector3(x - dx, ya, z - dz), new THREE.Vector3(x + dx, yb, z + dz), rad, rad * 0.6,
            { radial: 6, rings: 3, bend: 0.03, rough: 0.5, ao: false, color: [0.75, 0.68, 0.6], endColor: [0.5, 0.45, 0.4] });
        }
      }

      /* ---------------- 近くの木：幹と下枝。炎に照らされて闇から浮かぶ ---------------- */
      const boughTex = tex.bough;
      const fireCenter = new THREE.Vector3(0, 0.8, 0);
      {
        // [x, z, 根元の半径, 傾き x, 傾き z]
        const trunks = [
          [-3.9, -3.3, 0.21, 0.02, -0.01], [4.7, -4.5, 0.25, -0.025, 0.01], [-7.0, -7.6, 0.28, 0.01, 0.02],
          [2.7, -10.6, 0.24, -0.01, 0.0], [8.0, -9.2, 0.3, 0.015, -0.01], [-2.9, -13.2, 0.26, 0.0, 0.01],
          [-10.5, -4.2, 0.27, 0.02, 0.0], [10.6, -3.6, 0.24, -0.02, 0.01], [-5.2, -16.5, 0.3, 0.0, 0.0], [5.6, -15.8, 0.27, 0.0, 0.0],
        ];
        const cards = { pos: [], nor: [], uv: [], idx: [] };
        const dirV = new THREE.Vector3(), sideV = new THREE.Vector3(), nV = new THREE.Vector3(), pV = new THREE.Vector3();
        trunks.forEach((t) => {
          const hgt = 11, y0 = groundHeight(t[0], t[1]) - 0.05;
          const a = new THREE.Vector3(t[0], y0, t[1]);
          const b = new THREE.Vector3(t[0] + t[3] * hgt, y0 + hgt, t[1] + t[4] * hgt);
          addLog(a, b, t[2], t[2] * 0.62, { radial: 18, rings: 14, bend: 0.004, rough: 0.6, flare: 0.5, repeat: 1 });
          // 下枝：幹から外へ伸び、先へ行くほど垂れる細長い板（3 節）。面の向きに関係なく照らされるよう、法線は火のほうへ向ける
          const n = 24 + (rnd() * 8 | 0);
          for (let i = 0; i < n; i++) {
            const h = 2.2 + (i + rnd()) / n * 8.4;
            const az = rnd() * Math.PI * 2;
            const droop = 0.1 + rnd() * 0.35;
            const len = (2.3 - 0.1 * h) * (0.6 + rnd() * 0.6);
            const wid = len * (0.3 + rnd() * 0.1);
            const tilt = (rnd() - 0.5) * 0.9; // 板を枝の軸まわりに少しひねる
            dirV.set(Math.cos(az) * Math.cos(droop), -Math.sin(droop), Math.sin(az) * Math.cos(droop));
            sideV.set(-Math.sin(az) * Math.cos(tilt), Math.sin(tilt), Math.cos(az) * Math.cos(tilt));
            const ox = t[0] + t[3] * h + Math.cos(az) * t[2] * 0.6, oz = t[1] + t[4] * h + Math.sin(az) * t[2] * 0.6;
            const SEG = 3;
            // 1 枚目：枝ぶりを上から見た水平の板。2 枚目：枝から垂れる小枝の板（真横から見ても線にならない）
            for (let part = 0; part < 2; part++) {
              const base = cards.pos.length / 3;
              for (let sg = 0; sg <= SEG; sg++) {
                const u = sg / SEG;
                for (let v = 0; v <= 1; v++) {
                  pV.set(ox, y0 + h, oz).addScaledVector(dirV, u * len);
                  pV.y -= u * u * len * 0.3;
                  if (part === 0) pV.addScaledVector(sideV, (v - 0.5) * wid);
                  else pV.y -= v * wid * 0.5;
                  cards.pos.push(pV.x, pV.y, pV.z);
                  nV.subVectors(fireCenter, pV).normalize();
                  cards.nor.push(nV.x, nV.y, nV.z);
                  cards.uv.push(u, part === 0 ? v : 0.54 - v * 0.52);
                }
              }
              for (let sg = 0; sg < SEG; sg++) {
                const a0 = base + sg * 2, b0 = a0 + 1, c0 = a0 + 2, d0 = a0 + 3;
                cards.idx.push(a0, c0, b0, b0, c0, d0, a0, b0, c0, b0, d0, c0); // 表裏の両方を張る
              }
            }
          }
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(cards.pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(cards.nor, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(cards.uv, 2));
        geo.setIndex(cards.idx);
        const boughs = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: boughTex, alphaTest: 0.4, roughness: 1, metalness: 0 }));
        scene.add(boughs);
      }
      {
        const bark = new THREE.Mesh(mergeGeometries(THREE, props.bark), barkMat);
        bark.castShadow = true;
        bark.receiveShadow = true;
        scene.add(bark);
        const ends = new THREE.Mesh(mergeGeometries(THREE, props.ends), endMat);
        ends.castShadow = true;
        ends.receiveShadow = true;
        scene.add(ends);
      }

      /* ---------------- 木立：板に描いた針葉樹。中景は炎の光を受け、遠景は空を背にした影になる ---------------- */
      {
        const kinds = TREE_KINDS, texs = tex.trees, shrubTex = tex.shrub;

        const mid = texs.map(() => ({ pos: [], nor: [], uv: [], idx: [] }));
        const far = texs.map(() => ({ pos: [], nor: [], uv: [], idx: [] }));
        const shrubs = { pos: [], nor: [], uv: [], idx: [] };
        const nV = new THREE.Vector3();
        const addCard = (buf, x, z, w, h, flip) => {
          // 板はカメラの基準位置のほうを向ける
          const yaw = Math.atan2(camBase.x - x, camBase.z - z);
          const rx = Math.cos(yaw), rz = -Math.sin(yaw);
          const y = groundHeight(x, z) - 0.1;
          nV.set(-x, 1.5, -z).normalize();
          const base = buf.pos.length / 3;
          for (let k = 0; k < 4; k++) {
            const u = k % 2, v = k < 2 ? 0 : 1;
            buf.pos.push(x + rx * (u - 0.5) * w, y + v * h, z + rz * (u - 0.5) * w);
            buf.nor.push(nV.x, nV.y, nV.z);
            buf.uv.push(flip ? 1 - u : u, v);
          }
          buf.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        };
        // 画面の中央（焚き火の奥）は木を遠く低くして、空を開ける。左右は近く高くして額縁にする
        const centerness = (x, z) => { const a = Math.atan2(x, -(z - camBase.z)); return Math.exp(-(a * a) / 0.09); };
        // 樹種を選ぶ。空の開けた中央では、梢の尖ったトウヒだけにする（マツの丸い葉のかたまりは塊に見える）
        const pick = (c) => { let k = (rnd() * texs.length) | 0; if (c > 0.15 && kinds[k][0] === 'pine') k = 0; return k; };
        for (let i = 0; i < 46; i++) {
          const a = -Math.PI / 2 + (rnd() - 0.5) * 3.6;
          const r = 11.5 + rnd() * 13;
          const x = Math.cos(a) * r, z = Math.sin(a) * r;
          const c = centerness(x, z);
          if (rnd() < c * 0.95) continue;
          const h = (8 + rnd() * 7) * (1 - 0.3 * c);
          addCard(mid[pick(c)], x, z, h * 0.5, h, rnd() < 0.5);
        }
        for (let i = 0; i < 230; i++) {
          const a = -Math.PI / 2 + (rnd() - 0.5) * 4.4;
          let r = 27 + Math.pow(rnd(), 0.8) * 55;
          let x = Math.cos(a) * r, z = Math.sin(a) * r;
          const c = centerness(x, z);
          if (c > 0.25) { r = Math.max(r, 52 + rnd() * 34); x = Math.cos(a) * r; z = Math.sin(a) * r; }
          const h = (11 + rnd() * 9) * (1 - 0.32 * c);
          addCard(far[pick(c)], x, z, h * 0.5, h, rnd() < 0.5);
        }
        for (let i = 0; i < 90; i++) {
          const a = -Math.PI / 2 + (rnd() - 0.5) * 4.6;
          const r = 22 + rnd() * 40;
          const h = 1.6 + rnd() * 2.2;
          addCard(shrubs, Math.cos(a) * r, Math.sin(a) * r, h * 2.2, h, rnd() < 0.5);
        }
        const build = (buf) => {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
          geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
          geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
          geo.setIndex(buf.idx);
          return geo;
        };
        texs.forEach((tex, i) => {
          if (mid[i].idx.length) {
            const m = new THREE.Mesh(build(mid[i]), new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1, metalness: 0 }));
            scene.add(m);
          }
          if (far[i].idx.length) {
            const m = new THREE.Mesh(build(far[i]), new THREE.MeshBasicMaterial({ map: tex, color: 0x000000, alphaTest: 0.4, side: THREE.DoubleSide }));
            scene.add(m);
          }
        });
        scene.add(new THREE.Mesh(build(shrubs), new THREE.MeshBasicMaterial({ map: shrubTex, color: 0x000000, alphaTest: 0.4, side: THREE.DoubleSide })));
      }

      /* ---------------- 遠くの山並み ---------------- */
      {
        const seg = 240, R = 330;
        const pos = [], idx = [];
        const ridge = (a) => 16 + 15 * Math.sin(a * 2.0 + 0.6) + 9 * Math.sin(a * 5.1 + 2.2) + 4.5 * Math.sin(a * 11.3 + 0.9) + 2 * Math.sin(a * 23.7 + 4.1);
        for (let i = 0; i <= seg; i++) {
          const a = (i / seg) * Math.PI * 2;
          const x = Math.cos(a) * R, z = Math.sin(a) * R;
          pos.push(x, -4, z, x, Math.max(6, ridge(a)), z);
        }
        for (let i = 0; i < seg; i++) {
          const a = i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex(idx);
        const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.0045, 0.0075, 0.014), fog: false, side: THREE.DoubleSide });
        scene.add(new THREE.Mesh(geo, mat));
      }

      /* ---------------- 夜空：地平ほど明るい空、天の川、星 ---------------- */
      const galaxyN = new THREE.Vector3().crossVectors(
        new THREE.Vector3(0.25, 0.2, -1).normalize(), new THREE.Vector3(-0.45, 1, -0.35).normalize()).normalize();
      {
        const skyMat = new THREE.ShaderMaterial({
          uniforms: {
            tNoise: { value: noiseTex },
            uZenith: { value: new THREE.Color(0.0035, 0.0065, 0.015) },
            uHorizon: { value: new THREE.Color(0.012, 0.021, 0.036) },
            uAxis: { value: galaxyN },
            uE1: { value: new THREE.Vector3(0.25, 0.2, -1).normalize() },
          },
          vertexShader: `
            varying vec3 vDir;
            void main() {
              vDir = position;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
          fragmentShader: `
            uniform sampler2D tNoise;
            uniform vec3 uZenith;
            uniform vec3 uHorizon;
            uniform vec3 uAxis;
            uniform vec3 uE1;
            varying vec3 vDir;
            void main() {
              vec3 d = normalize(vDir);
              float h = max(d.y, 0.0);
              // 地平に近いほど大気が厚く、わずかに明るい（大気光）
              vec3 col = mix(uHorizon, uZenith, pow(h, 0.42));
              col += vec3(0.0025, 0.0045, 0.003) * exp(-h * 7.0);
              // 天の川：帯の面からの距離で淡くなり、ノイズで雲のような濃淡と暗黒帯を付ける
              float b = dot(d, uAxis);
              vec3 e2 = cross(uAxis, uE1);
              float lon = atan(dot(d, e2), dot(d, uE1));
              vec2 q = vec2(lon * 1.1, b * 2.4);
              float n = texture2D(tNoise, q * 0.31).r * 0.6 + texture2D(tNoise, q * 0.93 + 0.21).g * 0.4;
              float band = exp(-b * b * 11.0);
              float cloud = smoothstep(0.3, 0.78, n);
              float dust = smoothstep(0.42, 0.7, texture2D(tNoise, q * 0.57 + 0.63).b) * exp(-b * b * 55.0);
              float core = 0.55 + 1.0 * exp(-pow((lon - 0.35) / 0.8, 2.0));
              vec3 mw = mix(vec3(0.5, 0.6, 0.85), vec3(0.95, 0.8, 0.62), exp(-pow((lon - 0.35) / 0.6, 2.0)) * 0.7);
              col += mw * band * (0.25 + 0.95 * cloud) * (1.0 - 0.8 * dust) * core * 0.034 * smoothstep(-0.02, 0.2, d.y);
              gl_FragColor = vec4(col, 1.0);
            }`,
          side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
        });
        const sky = new THREE.Mesh(new THREE.SphereGeometry(520, 48, 24), skyMat);
        sky.renderOrder = -2;
        sky.frustumCulled = false;
        scene.add(sky);
      }
      const starUniforms = { uPx: { value: 1 }, uTime: uTime };
      {
        const count = lite ? 9000 : 14000;
        const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), info = new Float32Array(count * 2);
        const d = new THREE.Vector3();
        let n = 0;
        while (n < count) {
          const y = rnd() * 1.02 - 0.02, th = rnd() * Math.PI * 2, s = Math.sqrt(Math.max(0, 1 - y * y));
          d.set(Math.cos(th) * s, y, Math.sin(th) * s);
          // 天の川に沿って星が多い
          const b = d.dot(galaxyN);
          if (rnd() > 0.3 + 0.7 * Math.exp(-b * b * 9)) continue;
          pos[n * 3] = d.x * 500; pos[n * 3 + 1] = d.y * 500; pos[n * 3 + 2] = d.z * 500;
          // 明るさ：ほとんどが暗く、ごく少数だけ明るい
          const mag = Math.pow(rnd(), 7);
          info[n * 2] = mag;
          info[n * 2 + 1] = rnd();
          // 色：青白〜白〜橙（星の表面温度）
          const t = rnd();
          const c = t < 0.25 ? [0.7, 0.8, 1.0] : t < 0.7 ? [1.0, 0.97, 0.92] : t < 0.9 ? [1.0, 0.86, 0.66] : [1.0, 0.68, 0.45];
          col[n * 3] = c[0]; col[n * 3 + 1] = c[1]; col[n * 3 + 2] = c[2];
          n++;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 2));
        const mat = new THREE.ShaderMaterial({
          uniforms: starUniforms,
          vertexShader: `
            attribute vec2 aInfo;
            attribute vec3 color;
            uniform float uPx;
            uniform float uTime;
            varying vec3 vCol;
            void main() {
              vec3 d = normalize(position);
              // 瞬き：大気のゆらぎ。地平に近い星ほど強く瞬く
              float tw = 0.5 + 0.5 * sin(uTime * (2.0 + aInfo.y * 7.0) + aInfo.y * 90.0) * sin(uTime * (1.3 + aInfo.y * 3.1) + aInfo.y * 40.0);
              float amp = mix(0.55, 0.12, smoothstep(0.1, 0.7, d.y));
              float bright = (0.06 + 3.4 * aInfo.x) * (1.0 - amp + amp * 2.0 * tw);
              // 地平近くは大気で減光
              bright *= smoothstep(0.0, 0.22, d.y);
              float size = uPx * (1.1 + 1.9 * pow(aInfo.x, 0.4));
              vCol = color * bright;
              gl_PointSize = size;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
          fragmentShader: `
            varying vec3 vCol;
            void main() {
              float d = length(gl_PointCoord - 0.5) * 2.0;
              float a = 1.0 - smoothstep(0.0, 1.0, d);
              gl_FragColor = vec4(vCol * a * a, 1.0);
            }`,
          blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, toneMapped: false,
        });
        const stars = new THREE.Points(geo, mat);
        stars.renderOrder = -1;
        stars.frustumCulled = false;
        scene.add(stars);
      }

      /* ---------------- 炎・火の粉・煙 ---------------- */
      const fire = helpers.makeFire(THREE, renderer, scene, {
        camera,
        position: new THREE.Vector3(0, 0, 0),
        res: lite ? [144, 216] : [192, 288],
        iterations: lite ? 18 : 22,
        bright: 1.25,
        // 薪の組み方を正面から見た形：熾の床、手前 2 本の薪の上面、芯、頂点
        emitters: [
          { x1: -0.25, y1: 0.09, x2: 0.25, y2: 0.09, r: 0.055, w: 0.9 },
          { x1: -0.24, y1: 0.2, x2: 0.05, y2: 0.46, r: 0.04, w: 1 },
          { x1: 0.26, y1: 0.2, x2: -0.05, y2: 0.44, r: 0.04, w: 1 },
          { x1: -0.09, y1: 0.17, x2: 0.11, y2: 0.24, r: 0.05, w: 1 },
          { x1: -0.03, y1: 0.5, x2: 0.05, y2: 0.52, r: 0.035, w: 0.8 },
        ],
        // 中心の炎の手前に、別の流れで解いた小さめの炎を重ねる（薪を包む厚みが出る）
        planes: [
          {},
          { sim: 1, z: 0.17, x: -0.02, scale: 0.66, seed: 0.37, bright: 0.85 },
        ],
        sparks: { max: 400 },
        smoke: { max: 160, lit: 0x4a2a16, ambient: 0x05070a, opacity: 0.13 },
      });

      /* ---------------- 光 ---------------- */
      // 炎は点ではなく縦に長い光源なので、低い位置と高い位置の 2 灯に分ける（影の縁が二重になり、柔らかく見える）
      const fireColor = new THREE.Color(1.0, 0.47, 0.15);
      const mkLight = (y, size) => {
        const l = new THREE.PointLight(fireColor, 1, 46, 2);
        l.position.set(0, y, 0);
        l.castShadow = true;
        l.shadow.mapSize.set(size, size);
        l.shadow.camera.near = 0.08;
        l.shadow.camera.far = 46;
        l.shadow.bias = -0.0006;      // 奥行きの正規化単位（× 46m ≒ 3cm）
        l.shadow.normalBias = 0.015;
        l.shadow.radius = 6;          // 地面では影の縁の幅（softPointShadows 参照）
        scene.add(l);
        return l;
      };
      const lightLow = mkLight(0.42, 512);
      const lightHigh = mkLight(0.95, 512);
      // 熾の照り返し：囲いの内側だけを赤く染める弱い光（影なし・届く範囲を短く）
      const emberLight = new THREE.PointLight(new THREE.Color(1.0, 0.22, 0.04), 1, 1.0, 2);
      emberLight.position.set(0, 0.16, 0);
      scene.add(emberLight);
      // 星明かり
      scene.add(new THREE.HemisphereLight(new THREE.Color(0.33, 0.48, 0.9), new THREE.Color(0.02, 0.02, 0.03), 0.085));

      /* ---------------- ポストエフェクト ---------------- */
      const post = helpers.makePost(THREE, renderer, { bloom: 0.5, threshold: 1.15, vignette: 0.55, grain: 0.028 });
      const hazeWorld = new THREE.Vector3();
      const haze = { x: 0.5, y: 0.5, width: 0.1, height: 0.4, strength: 0, lean: 0 };
      const bufSize = new THREE.Vector2();
      const lightNoise = helpers.makeFluctuation({ octaves: 5, baseFreq: 1 / 3 });

      let time = 0;
      let power = 1;
      let wind = 0;
      const I0 = 22; // 炎の光度の基準

      // 重い端末への保険：コマ落ちが続いたら描画の解像度を段階的に下げる（上げ直しはしない）
      const basePixelRatio = renderer.getPixelRatio();
      const perf = { warm: 2, t: 0, n: 0, drops: 0 };
      const watchPerformance = (dt) => {
        if (document.visibilityState !== 'visible') return;
        if (perf.warm > 0) { perf.warm -= dt; return; }
        perf.t += dt; perf.n++;
        if (perf.t < 2.5) return;
        // 平均 27fps 未満なら 0.75 倍に（30fps 上限の省電力モードでは下げない）
        if (perf.t / perf.n > 1 / 27 && perf.drops < 3) {
          perf.drops++;
          renderer.setPixelRatio(Math.max(0.6, renderer.getPixelRatio() * 0.75));
          perf.warm = 1;
        }
        perf.t = 0; perf.n = 0;
      };

      return {
        update(dt, t, p) {
          time = t;
          power = p.power;
          wind = p.wind;
          uTime.value = t;
          watchPerformance(dt);
          renderer.getDrawingBufferSize(bufSize);
          fire.update(dt, t, {
            power: p.power, wind: p.wind, sparks: p.embers, smoke: p.smoke,
            viewWidth: bufSize.x, viewHeight: bufSize.y, pixelRatio: renderer.getPixelRatio(),
          });

          // 光は炎と同じ拍で明滅し、炎の揺れに合わせて位置も動く（影が踊る）
          const f = fire.flicker.value;
          const pw = Math.pow(p.power, 0.85);
          const sx = lightNoise.sample(t, 1.3), sz = lightNoise.sample(t + 31.7, 1.3), sy = lightNoise.sample(t + 77.1, 1.3);
          const leanX = p.wind * 0.03;
          lightLow.intensity = I0 * 0.5 * pw * f;
          lightHigh.intensity = I0 * 0.5 * pw * (0.4 + 0.6 * f) * (0.9 + 0.1 * sy);
          lightLow.position.set(sx * 0.07 + leanX, 0.36 + 0.08 * pw + sy * 0.03, sz * 0.07);
          lightHigh.position.set(sz * 0.12 + leanX * 3, 0.55 + 0.45 * pw + sy * 0.08, sx * 0.1);
          emberLight.intensity = 1.6 * (0.6 + 0.4 * pw) * (0.85 + 0.15 * f);
          uGlow.value = (0.55 + 0.45 * pw) * (0.9 + 0.2 * (f - 1));
          uLogHeat.value = (0.5 + 0.5 * pw) * (0.85 + 0.3 * (f - 1));
          starUniforms.uPx.value = renderer.getPixelRatio();

          // ゆっくりしたカメラの揺れ
          if (!reduceMotion) {
            camera.position.x = camBase.x + Math.sin(t * 0.13) * 0.35;
            camera.position.y = camBase.y + Math.sin(t * 0.19) * 0.05;
            camera.lookAt(camAim);
          }
        },
        render(renderer, scene, camera) {
          // 陽炎の位置：炎の少し上を画面座標に投影。風でなびく
          hazeWorld.set(0, 0.5 + 0.8 * Math.pow(power, 0.6), 0).project(camera);
          haze.x = hazeWorld.x * 0.5 + 0.5;
          haze.y = hazeWorld.y * 0.5 + 0.5;
          haze.width = 0.07 + 0.035 * power;
          haze.height = 0.32 + 0.14 * power;
          haze.lean = wind * 0.09;
          haze.strength = reduceMotion ? 0.002 : 0.0055 * Math.pow(power, 0.5);
          post.render(scene, camera, { time, haze });
        },
        dispose() {
          post.dispose();
          fire.dispose();
          owned.forEach((o) => o.dispose());
          if (renderer.getPixelRatio() !== basePixelRatio) renderer.setPixelRatio(basePixelRatio);
        },
      };
    },
  });
})();
