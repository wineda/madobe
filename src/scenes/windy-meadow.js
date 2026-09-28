/* 風の草原 — 昼下がりの草原。風の強さが 1/f ゆらぎで刻々と変わり、草・広葉の草・葦が揺れる。
 * 「ゆらぎ β」でゆらぎの質を変えられる：0 = 白色（せわしない）、1 = 1/f（自然）、2 = ブラウン（ゆったり）。
 * 風速の積分を突風の波の位相にしているので、強い風のときは草原を波が渡っていく。
 */
(function () {
  'use strict';

  const SKY_VERT = `
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;
  // 3色グラデーション＋太陽＋風で流れる雲（平面投影したノイズ）
  const SKY_FRAG = `
    uniform vec3 uHorizon;
    uniform vec3 uMid;
    uniform vec3 uZenith;
    uniform vec3 uSunColor;
    uniform vec3 uSunDir;
    uniform float uCloud;
    uniform vec2 uCloudOffset;
    varying vec3 vWorldPos;
    float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float noise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm(vec2 p) {
      float v = 0.0; float a = 0.5;
      for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.0; a *= 0.5; }
      return v;
    }
    void main() {
      vec3 d = normalize(vWorldPos - cameraPosition);
      float h = d.y;
      float t1 = smoothstep(-0.02, 0.2, h);
      float t2 = smoothstep(0.1, 0.8, h);
      vec3 col = mix(uHorizon, uMid, t1);
      col = mix(col, uZenith, t2);
      float sd = max(dot(d, uSunDir), 0.0);
      col += uSunColor * (pow(sd, 6.0) * 0.18 + pow(sd, 80.0) * 0.5 + pow(sd, 900.0) * 1.5);
      // 雲：空を平面に投影して fbm。密度は高さで薄くなり、太陽側が明るい
      float band = smoothstep(0.02, 0.12, h);
      vec2 cp = d.xz / max(h, 0.02) * 0.12 + uCloudOffset;
      float n = fbm(cp);
      float cloud = band * smoothstep(0.5, 0.72, n) * uCloud;
      float lit = 0.55 + 0.45 * pow(sd, 2.0);
      vec3 cloudCol = mix(uMid * 0.85 + 0.15, uSunColor, 0.35) * lit;
      col = mix(col, cloudCol, clamp(cloud, 0.0, 1.0) * 0.9);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }
  `;

  madobe.register({
    id: 'windy-meadow',
    name: '風の草原',
    meta: 'wind · 1/f · meadow',
    params: [
      { key: 'wind', label: '風の強さ', min: 0,   max: 6, step: 0.25, value: 2.5 },
      { key: 'beta', label: 'ゆらぎ β', min: 0,   max: 2, step: 0.1,  value: 1 },
      { key: 'sun',  label: '日の高さ', min: 0.1, max: 1, step: 0.01, value: 0.55 },
    ],

    create({ THREE, renderer, scene, camera, params, reduceMotion, helpers }) {
      renderer.shadowMap.enabled = true;

      camera.near = 0.1;
      camera.far = 700;
      camera.updateProjectionMatrix();
      const camBase = new THREE.Vector3(0, 1.35, 7);
      const lookAt = new THREE.Vector3(0, 1.1, -30);
      camera.position.copy(camBase);
      camera.lookAt(lookAt);

      const AZIMUTH = -0.6; // 太陽の方位（ラジアン）。左奥
      const srgb = (hex) => new THREE.Color(hex).convertSRGBToLinear();
      const lerp = THREE.MathUtils.lerp;
      const degToRad = THREE.MathUtils.degToRad;

      // 日の高さ 0 → 1 のキーフレーム（低い午後の光 → 高い昼の光）
      const KEYS = [
        { el: 8,  horizon: srgb(0xf1c891), mid: srgb(0xa9bdd6), zenith: srgb(0x4b79b8), sun: srgb(0xffd9a6), fog: srgb(0xd9c6a8), dir: 1.0, hemi: 0.55, exposure: 0.95, cloud: 0.75 },
        { el: 58, horizon: srgb(0xd8e6f2), mid: srgb(0x7fb0e3), zenith: srgb(0x2f6fc6), sun: srgb(0xfff8ea), fog: srgb(0xc9d8e6), dir: 1.35, hemi: 0.7,  exposure: 1.0,  cloud: 0.6 },
      ];

      // ---- 空 ----
      const uniforms = {
        uHorizon: { value: new THREE.Color() },
        uMid: { value: new THREE.Color() },
        uZenith: { value: new THREE.Color() },
        uSunColor: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uCloud: { value: 0.6 },
        uCloudOffset: { value: new THREE.Vector2(Math.random() * 10, Math.random() * 10) },
      };
      const sky = new THREE.Mesh(
        new THREE.SphereGeometry(300, 48, 24),
        new THREE.ShaderMaterial({ uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false })
      );
      sky.renderOrder = -1;
      sky.frustumCulled = false;
      scene.add(sky);

      // ---- 地面：土と下草の色むら（ランダム格子のバイリニア補間。継ぎ目なし）----
      const texCanvas = document.createElement('canvas');
      texCanvas.width = texCanvas.height = 256;
      const tctx = texCanvas.getContext('2d');
      const img = tctx.createImageData(256, 256);
      const gridN = 12;
      const grid = new Float32Array(gridN * gridN);
      for (let i = 0; i < grid.length; i++) grid[i] = Math.random();
      const g = (a, b) => grid[((b % gridN) + gridN) % gridN * gridN + ((a % gridN) + gridN) % gridN];
      for (let i = 0; i < 256 * 256; i++) {
        const x = i % 256, y = (i / 256) | 0;
        const gx = (x / 256) * gridN, gy = (y / 256) * gridN;
        const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
        const c = (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
        const v = 110 + (c - 0.5) * 80 + (Math.random() - 0.5) * 50;
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = Math.max(0, Math.min(255, v));
        img.data[i * 4 + 3] = 255;
      }
      tctx.putImageData(img, 0, 0);
      const groundTex = new THREE.CanvasTexture(texCanvas);
      groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
      groundTex.repeat.set(40, 40);
      groundTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(600, 600),
        new THREE.MeshStandardMaterial({ color: srgb(0x6d7a3c), map: groundTex, roughness: 0.95, metalness: 0 })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      scene.add(ground);

      scene.fog = new THREE.Fog(0x000000, 30, 260);

      // ---- 光 ----
      const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 0.6);
      scene.add(hemi);
      const dirLight = new THREE.DirectionalLight(0xffffff, 1);
      dirLight.castShadow = true;
      dirLight.shadow.mapSize.set(2048, 2048);
      const sc = dirLight.shadow.camera;
      sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30;
      sc.near = 1; sc.far = 200;
      dirLight.shadow.bias = -0.003;
      dirLight.target.position.set(0, 0, -8);
      scene.add(dirLight, dirLight.target);

      // ---- 遠景：丘の稜線と木立 ----
      const hillMat = new THREE.MeshStandardMaterial({ color: srgb(0x5f7a3e), roughness: 1 });
      [[-120, 24, 220], [60, 18, 260], [180, 30, 300], [-40, 14, 190]].forEach(([x, h, z]) => {
        const hill = new THREE.Mesh(new THREE.SphereGeometry(h * 3.2, 24, 12), hillMat);
        hill.scale.set(1.8, 1, 1);
        hill.position.set(x, -h * 3.2 + h, -z);
        scene.add(hill);
      });
      const treeMat = new THREE.MeshStandardMaterial({ color: srgb(0x2f4a26), roughness: 1 });
      const trunkMat = new THREE.MeshStandardMaterial({ color: srgb(0x4a3a2a), roughness: 1 });
      // 遠くの木立は霧で淡くなり、地平線の目印になる程度にとどめる
      for (let i = 0; i < 44; i++) {
        const a = (Math.random() - 0.5) * 2.2;
        const r = 85 + Math.random() * 70;
        const h = 5 + Math.random() * 6;
        const x = Math.sin(a) * r, z = -Math.cos(a) * r;
        const crown = new THREE.Mesh(new THREE.SphereGeometry(h * 0.42, 9, 7), treeMat);
        crown.position.set(x, h * 0.95, z);
        crown.scale.set(1.1, 1.2, 1.1);
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, h, 6), trunkMat);
        trunk.position.set(x, h / 2, z);
        scene.add(crown, trunk);
      }

      // ---- 草木：3層。密な下草、広葉の草、背の高い葦 ----
      const field = (r0, r1, z0, z1) => () => [
        (Math.random() - 0.5) * 2 * lerp(r0, r1, Math.pow(Math.random(), 0.7)),
        z0 + Math.random() * (z1 - z0),
      ];
      const grass = helpers.makeGrass(THREE, scene, {
        count: 3200,
        place: field(0, 30, -42, 10),
        clusters: { count: 120, radius: 2.5, ratio: 0.6 },
        height: [0.3, 0.75],
        bladeWidth: 0.07,
        spread: 0.35,
        color: srgb(0x7f9a3e),
        tint: 0.35,
        roughness: 0.9,
      });
      const broad = helpers.makeGrass(THREE, scene, {
        count: 420,
        place: field(0, 26, -36, 9),
        clusters: { count: 40, radius: 1.8, ratio: 0.8 },
        height: [0.5, 1.0],
        blades: 3,
        bladeWidth: 0.16,
        spread: 0.55,
        color: srgb(0x4f8a3a),
        tint: 0.3,
        roughness: 0.85,
      });
      const reeds = helpers.makeGrass(THREE, scene, {
        count: 360,
        place: field(0, 24, -34, 8),
        clusters: { count: 30, radius: 1.6, ratio: 0.85 },
        height: [1.4, 2.4],
        blades: 6,
        bladeWidth: 0.03,
        spread: 0.22,
        color: srgb(0xc2b36a),
        tint: 0.25,
        roughness: 0.8,
      });
      const sway = reduceMotion ? 0.35 : 1;

      // ---- 風：1/f ゆらぎ ----
      const gust = helpers.makeFluctuation({ octaves: 8, baseFreq: 1 / 32 });
      let windNow = params.wind;
      let gustPhase = 0;
      let cloudDrift = 0;

      // ---- 日の高さ ----
      const sunDir = new THREE.Vector3();
      function applySun(s) {
        s = Math.min(1, Math.max(0, s));
        const A = KEYS[0], B = KEYS[1];
        const L = (k) => lerp(A[k], B[k], s);
        uniforms.uHorizon.value.copy(A.horizon).lerp(B.horizon, s);
        uniforms.uMid.value.copy(A.mid).lerp(B.mid, s);
        uniforms.uZenith.value.copy(A.zenith).lerp(B.zenith, s);
        uniforms.uSunColor.value.copy(A.sun).lerp(B.sun, s);
        uniforms.uCloud.value = L('cloud');
        const el = degToRad(L('el'));
        sunDir.set(Math.sin(AZIMUTH) * Math.cos(el), Math.sin(el), -Math.cos(AZIMUTH) * Math.cos(el)).normalize();
        uniforms.uSunDir.value.copy(sunDir);
        dirLight.position.copy(dirLight.target.position).addScaledVector(sunDir, 90);
        dirLight.color.copy(uniforms.uSunColor.value);
        dirLight.intensity = L('dir');
        scene.fog.color.copy(A.fog).lerp(B.fog, s);
        hemi.color.copy(uniforms.uMid.value);
        hemi.groundColor.copy(scene.fog.color).multiplyScalar(0.5);
        hemi.intensity = L('hemi');
        renderer.toneMappingExposure = L('exposure');
      }
      applySun(params.sun);

      return {
        update(dt, t, p) {
          // 風の強さ = 設定値 × (1 + 0.9 × 1/f ゆらぎ)。凪も突風も 1/f のリズムで来る
          const n = gust.sample(t, p.beta);
          const target = p.wind * Math.max(0, 1 + 0.9 * n);
          windNow += (target - windNow) * Math.min(1, dt * 6); // 急変を少しだけ均す
          gustPhase += windNow * dt * 0.9;                       // 突風の波は風速で進む
          cloudDrift += windNow * dt * 0.0025;
          uniforms.uCloudOffset.value.x = cloudDrift;

          const w = { wind: windNow, sway, gustPhase, gustAmp: 0.12 * Math.min(1, windNow / 3) };
          grass.update(dt, t, w);
          broad.update(dt, t, w);
          reeds.update(dt, t, w);

          if (!reduceMotion) {
            camera.position.x = camBase.x + Math.sin(t * 0.12) * 0.6;
            camera.position.y = camBase.y + Math.sin(t * 0.19) * 0.08 + windNow * 0.004 * Math.sin(t * 1.7);
            camera.lookAt(lookAt);
          }
        },
        onParam(key, value) {
          if (key === 'sun') applySun(value);
        },
        dispose() {
          groundTex.dispose();
        },
      };
    },
  });
})();
