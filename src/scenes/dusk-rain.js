/* 夕暮れの雨 — 沈みかけの太陽、地平線近くの雲の帯、濡れた道に映る空。
 * 「日の高さ」スライダーで空の色・太陽の位置・光・霧・露出をまとめて補間する。
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

  // 地平線→中間→天頂の3色グラデーション＋太陽のハロー＋地平線近くの雲の帯
  const SKY_FRAG = `
    uniform vec3 uHorizon;
    uniform vec3 uMid;
    uniform vec3 uZenith;
    uniform vec3 uSunColor;
    uniform vec3 uSunDir;
    uniform float uCloud;
    uniform float uTime;
    varying vec3 vWorldPos;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
        f.y
      );
    }
    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 4; i++) {
        v += a * noise(p);
        p = p * 2.03 + 17.0;
        a *= 0.5;
      }
      return v;
    }

    void main() {
      vec3 d = normalize(vWorldPos - cameraPosition);
      float h = d.y;

      // 3色グラデーション
      float t1 = smoothstep(-0.02, 0.25, h);
      float t2 = smoothstep(0.15, 0.85, h);
      vec3 col = mix(uHorizon, uMid, t1);
      col = mix(col, uZenith, t2);

      // 太陽の方角の地平線を暖色に
      float lxz = length(d.xz);
      float az = lxz > 1e-4 ? dot(d.xz / lxz, normalize(uSunDir.xz)) : 0.0;
      float warm = (1.0 - t1) * smoothstep(-0.2, 1.0, az) * 0.35;
      col = mix(col, uSunColor, warm * 0.5);

      // 太陽のハローと円盤
      float sd = max(dot(d, uSunDir), 0.0);
      float glow = pow(sd, 8.0) * 0.25 + pow(sd, 64.0) * 0.5 + pow(sd, 600.0) * 1.2;
      col += uSunColor * glow;

      // 地平線近くの雲の帯（平面投影したノイズ。継ぎ目なし）
      float band = smoothstep(0.01, 0.06, h) * (1.0 - smoothstep(0.10, 0.45, h));
      vec2 cp = d.xz / max(h, 0.015) * 0.18 + vec2(uTime * 0.006, 0.0);
      float n = fbm(cp);
      float cloud = band * smoothstep(0.42, 0.68, n) * uCloud;
      float lit = pow(sd, 3.0) * 0.6;
      vec3 cloudCol = mix(uMid * 0.6, uSunColor, lit);
      col = mix(col, cloudCol, clamp(cloud, 0.0, 1.0) * 0.85);

      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }
  `;

  madobe.register({
    id: 'dusk-rain',
    name: '夕暮れの雨',
    meta: 'rain · dusk · golden hour',
    params: [
      { key: 'sun',   label: '日の高さ', min: 0,  max: 1,    step: 0.01, value: 0.45 },
      { key: 'count', label: '雨量',     min: 0,  max: 3000, step: 100,  value: 1200 },
      { key: 'wind',  label: '風',       min: -6, max: 6,    step: 0.5,  value: -2 },
    ],

    create({ THREE, renderer, scene, camera, params, reduceMotion, helpers }) {
      renderer.shadowMap.enabled = true;

      camera.near = 0.1;
      camera.far = 800;
      camera.updateProjectionMatrix();
      const camBase = new THREE.Vector3(0, 2.6, 12);
      const lookAt = new THREE.Vector3(0, 3.5, -40);
      camera.position.copy(camBase);
      camera.lookAt(lookAt);

      const AZIMUTH = 0.12; // 太陽の方位（ラジアン、0 = 正面）。道の先、少し右に沈む
      const srgb = (hex) => new THREE.Color(hex).convertSRGBToLinear();
      const lerp = THREE.MathUtils.lerp;
      const degToRad = THREE.MathUtils.degToRad;

      // 日の高さ 0 → 0.5 → 1 のキーフレーム（色は sRGB で指定）
      const KEYS = [
        { el: -3, horizon: srgb(0x6b4a5e), mid: srgb(0x2f3358), zenith: srgb(0x0d1026), sun: srgb(0xff9a6a), fog: srgb(0x4a3a50), dir: 0.05, hemi: 0.35, exposure: 0.85, cloud: 0.75 },
        { el:  5, horizon: srgb(0xffa25c), mid: srgb(0xc46a7c), zenith: srgb(0x3d4f86), sun: srgb(0xfff0c0), fog: srgb(0xc58a78), dir: 0.65, hemi: 0.55, exposure: 1.0,  cloud: 0.7 },
        { el: 22, horizon: srgb(0xe9c79c), mid: srgb(0x93aacb), zenith: srgb(0x3f6fb5), sun: srgb(0xfff6e4), fog: srgb(0xcdbcae), dir: 0.55, hemi: 0.7,  exposure: 0.9,  cloud: 0.6 },
      ];

      // ---- 空 ----
      const uniforms = {
        uHorizon:  { value: new THREE.Color() },
        uMid:      { value: new THREE.Color() },
        uZenith:   { value: new THREE.Color() },
        uSunColor: { value: new THREE.Color() },
        uSunDir:   { value: new THREE.Vector3(0, 0.2, -1) },
        uCloud:    { value: 0.7 },
        uTime:     { value: 0 },
      };
      const skyMat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
      });
      const skyGeo = new THREE.SphereGeometry(300, 48, 24);
      const sky = new THREE.Mesh(skyGeo, skyMat);
      sky.renderOrder = -1;
      sky.frustumCulled = false;
      scene.add(sky);

      // 地面に映す環境マップ。空だけの別シーンを PMREMGenerator で撮る（日の高さが変わったときだけ）。
      // CubeCamera + ミップマップだと面の境界に筋が出るので、roughness 対応で継ぎ目のない PMREM を使う
      const envScene = new THREE.Scene();
      envScene.add(new THREE.Mesh(skyGeo, skyMat));
      const pmrem = new THREE.PMREMGenerator(renderer);
      let envTarget = null;
      let envDirty = true;

      // ---- 地面：濡れた道 ----
      // 水の膜＝誘電体なので metalness は低く、フレネルで遠くほど空を映す
      const groundMat = new THREE.MeshStandardMaterial({
        color: srgb(0x262320),
        roughness: 0.5,
        metalness: 0.12,
        envMapIntensity: 0.8,
      });
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), groundMat);
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      scene.add(ground);

      function captureEnv() {
        const next = pmrem.fromScene(envScene, 0, 0.1, 1000);
        groundMat.envMap = next.texture;
        if (envTarget) envTarget.dispose();
        envTarget = next;
      }

      scene.fog = new THREE.Fog(0x000000, 20, 260);

      // ---- 光 ----
      const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 0.5);
      scene.add(hemi);
      const dirLight = new THREE.DirectionalLight(0xffffff, 1);
      dirLight.castShadow = true;
      dirLight.shadow.mapSize.set(2048, 2048);
      const sc = dirLight.shadow.camera;
      sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40;
      sc.near = 1; sc.far = 250;
      // 低い太陽は地面に対してすれすれなので、自己遮蔽（アクネ）を避けるため大きめの負バイアス
      dirLight.shadow.bias = -0.004;
      dirLight.target.position.set(0, 0, -12);
      scene.add(dirLight, dirLight.target);

      // ---- 遠景：稜線2層（ShapeGeometry のシルエット。霧で奥ほど淡くなる）----
      // 太陽の方角（AZIMUTH）に谷を作り、低い夕日が稜線の間から見えるようにする
      function ridge(z, base, amp, seed, color, dip) {
        const dipX = Math.tan(AZIMUTH) * (camBase.z - z);
        const shape = new THREE.Shape();
        shape.moveTo(-500, -30);
        for (let x = -500; x <= 500; x += 10) {
          const g = Math.exp(-Math.pow((x - dipX) / (dip * 4), 2));
          const y = base - dip * g + amp * (1 - 0.7 * g) * (
            0.55 * Math.sin(x * 0.012 + seed) +
            0.30 * Math.sin(x * 0.031 + seed * 1.7) +
            0.15 * Math.sin(x * 0.083 + seed * 3.1)
          );
          shape.lineTo(x, y);
        }
        shape.lineTo(500, -30);
        shape.closePath();
        const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color }));
        m.position.z = z;
        scene.add(m);
        return m;
      }
      ridge(-160, 22, 12, 1.3, srgb(0x2a2440), 11);
      ridge(-95, 11, 6, 4.1, srgb(0x17131f), 7);

      // ---- 家並み（配置は固定乱数で毎回同じ）----
      let seed = 7;
      const rnd = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };
      const houseMat = new THREE.MeshStandardMaterial({ color: srgb(0x3a323a), roughness: 0.9 });
      const roofMat = new THREE.MeshStandardMaterial({ color: srgb(0x241f28), roughness: 0.85 });
      const winGeo = new THREE.PlaneGeometry(0.5, 0.65);
      const WIN = srgb(0xffc36e);
      const winMat = new THREE.MeshBasicMaterial({ color: WIN.clone() });
      for (let i = 0; i < 14; i++) {
        const side = i % 2 ? 1 : -1;
        const w = 3 + rnd() * 4;
        const d = 3 + rnd() * 3;
        const h = 2.4 + rnd() * 3;
        const x = side * (7 + rnd() * 36);
        const z = -16 - rnd() * 34;

        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), houseMat);
        body.position.set(x, h / 2, z);
        body.castShadow = true;
        body.receiveShadow = true;
        scene.add(body);

        const roofH = 1.2 + rnd() * 1.2;
        const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.72, roofH, 4), roofMat);
        roof.position.set(x, h + roofH / 2, z);
        roof.rotation.y = Math.PI / 4;
        roof.castShadow = true;
        scene.add(roof);

        // 灯りのついた窓（暗くなるほど明るく見える）
        const n = Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) {
          const win = new THREE.Mesh(winGeo, winMat);
          win.position.set(x - w / 2 + 0.8 + rnd() * (w - 1.6), 0.9 + rnd() * (h - 1.6), z + d / 2 + 0.02);
          scene.add(win);
        }
      }

      // ---- 電柱と電線 ----
      const poleMat = new THREE.MeshStandardMaterial({ color: srgb(0x2b2622), roughness: 0.8 });
      const wireMat = new THREE.LineBasicMaterial({ color: srgb(0x100e14) });
      const poleGeo = new THREE.CylinderGeometry(0.1, 0.14, 9, 10);
      const armGeo = new THREE.BoxGeometry(1.8, 0.12, 0.12);
      const tops = [];
      [2, -12, -26, -40].forEach((z) => {
        const p = new THREE.Mesh(poleGeo, poleMat);
        p.position.set(5.5, 4.5, z);
        p.castShadow = true;
        scene.add(p);
        const a = new THREE.Mesh(armGeo, poleMat);
        a.position.set(5.5, 8.6, z);
        a.castShadow = true;
        scene.add(a);
        tops.push(new THREE.Vector3(5.5, 8.6, z));
      });
      for (let i = 0; i < tops.length - 1; i++) {
        [-0.8, 0.8].forEach((dx) => {
          const a = tops[i].clone().add(new THREE.Vector3(dx, 0.06, 0));
          const b = tops[i + 1].clone().add(new THREE.Vector3(dx, 0.06, 0));
          const mid = a.clone().lerp(b, 0.5);
          mid.y -= 0.7;
          const pts = new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(16);
          scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat));
        });
      }

      // ---- 雨と波紋 ----
      const rain = helpers.makeRain(THREE, scene, {
        max: 3000,
        area: { x: 36, z: 36, top: 20 },
        color: srgb(0xe9e1d8),
        opacity: 0.38,
      });
      const ripples = helpers.makeRipples(THREE, scene, {
        count: 50,
        color: srgb(0xffe6d0),
        maxOpacity: 0.25,
        speed: 1.4,
      });
      const onLand = (x, z) => {
        if (Math.random() < 0.04 && Math.abs(x) < 14 && Math.abs(z) < 14) ripples.spawn(x, z);
      };

      // ---- 日の高さ：キーフレーム間を補間して全部に反映 ----
      const sunDir = new THREE.Vector3();
      const lightDir = new THREE.Vector3();

      function applySun(s) {
        s = Math.min(1, Math.max(0, s));
        const f = s * (KEYS.length - 1);
        const i = Math.min(KEYS.length - 2, Math.floor(f));
        const a = f - i;
        const A = KEYS[i];
        const B = KEYS[i + 1];
        const L = (k) => lerp(A[k], B[k], a);

        uniforms.uHorizon.value.copy(A.horizon).lerp(B.horizon, a);
        uniforms.uMid.value.copy(A.mid).lerp(B.mid, a);
        uniforms.uZenith.value.copy(A.zenith).lerp(B.zenith, a);
        uniforms.uSunColor.value.copy(A.sun).lerp(B.sun, a);
        uniforms.uCloud.value = L('cloud');

        const el = degToRad(L('el'));
        sunDir.set(Math.sin(AZIMUTH) * Math.cos(el), Math.sin(el), -Math.cos(AZIMUTH) * Math.cos(el)).normalize();
        uniforms.uSunDir.value.copy(sunDir);

        // 太陽が沈んでも光源は地平線の少し上に留める（影がすれすれになりすぎないよう最低 6°）
        const lel = Math.max(el, degToRad(6));
        lightDir.set(Math.sin(AZIMUTH) * Math.cos(lel), Math.sin(lel), -Math.cos(AZIMUTH) * Math.cos(lel)).normalize();
        dirLight.position.copy(dirLight.target.position).addScaledVector(lightDir, 80);
        dirLight.color.copy(uniforms.uSunColor.value);
        dirLight.intensity = L('dir');

        scene.fog.color.copy(A.fog).lerp(B.fog, a);
        hemi.color.copy(uniforms.uMid.value);
        hemi.groundColor.copy(scene.fog.color).multiplyScalar(0.6);
        hemi.intensity = L('hemi');

        renderer.toneMappingExposure = L('exposure');
        winMat.color.copy(WIN).multiplyScalar(0.2 + 1.3 * (1 - s));
        envDirty = true;
      }
      applySun(params.sun);

      return {
        update(dt, t, p) {
          uniforms.uTime.value = t;
          if (envDirty) {
            captureEnv();
            envDirty = false;
          }
          rain.update(dt, { count: p.count, wind: p.wind, speed: 22 }, onLand);
          ripples.update(dt);
          if (!reduceMotion) {
            camera.position.x = camBase.x + Math.sin(t * 0.15) * 0.8;
            camera.position.y = camBase.y + Math.sin(t * 0.23) * 0.15;
            camera.lookAt(lookAt);
          }
        },
        onParam(key, value) {
          if (key === 'sun') applySun(value);
        },
        dispose() {
          if (envTarget) envTarget.dispose();
          pmrem.dispose();
        },
      };
    },
  });
})();
