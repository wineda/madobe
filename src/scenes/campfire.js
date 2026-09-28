/* 焚き火 — 夜の野原で、ゆらゆら揺れる炎を眺める。炎と火の粉は helpers.makeFlame。 */
madobe.register({
  id: 'campfire',
  name: '焚き火',
  meta: 'fire · night · field',
  params: [
    { key: 'power',  label: '火の勢い', min: 0.2, max: 2,   step: 0.1, value: 1 },
    { key: 'wind',   label: '風',       min: -4,  max: 4,   step: 0.5, value: 0.5 },
    { key: 'embers', label: '火の粉',   min: 0,   max: 400, step: 20,  value: 160 },
  ],

  create({ THREE, renderer, scene, camera, reduceMotion, helpers }) {
    renderer.shadowMap.enabled = true;
    renderer.toneMappingExposure = 1.05;

    scene.background = new THREE.Color(0x04060b);
    scene.fog = new THREE.FogExp2(0x04060b, 0.04);

    camera.near = 0.1;
    camera.far = 200;
    camera.updateProjectionMatrix();
    const camBase = new THREE.Vector3(0, 1.7, 6.8);
    const camAim = new THREE.Vector3(0, 0.9, 0);
    camera.position.copy(camBase);
    camera.lookAt(camAim);

    // ---- 地面：乾いた土 ----
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: 0x17110d, roughness: 0.95, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // 炎の足元：燃え残りの熾（おき）。加算合成の円盤で赤く脈打つ
    const bed = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 32),
      new THREE.MeshBasicMaterial({ color: 0xff5a14, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    bed.rotation.x = -Math.PI / 2;
    bed.position.y = 0.02;
    scene.add(bed);

    // ---- 石の囲い ----
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x4a4744, roughness: 0.9, metalness: 0.05 });
    const stoneGeo = new THREE.DodecahedronGeometry(0.26, 0);
    const stones = 13;
    for (let i = 0; i < stones; i++) {
      const a = (i / stones) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
      const r = 1.05 + (Math.random() - 0.5) * 0.15;
      const s = new THREE.Mesh(stoneGeo, stoneMat);
      s.position.set(Math.cos(a) * r, 0.14, Math.sin(a) * r);
      s.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      const k = 0.75 + Math.random() * 0.5;
      s.scale.set(k, k * 0.7, k);
      s.castShadow = true;
      s.receiveShadow = true;
      scene.add(s);
    }

    // ---- 薪：3本を地面から中心へ傾けて組む ----
    const logMat = new THREE.MeshStandardMaterial({ color: 0x3a2517, roughness: 0.85, metalness: 0 });
    const logGeo = new THREE.CylinderGeometry(0.1, 0.12, 1.3, 10);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      const foot = new THREE.Vector3(Math.cos(a) * 0.6, 0.1, Math.sin(a) * 0.6);
      const head = new THREE.Vector3(Math.cos(a + Math.PI) * 0.12, 1.05, Math.sin(a + Math.PI) * 0.12);
      const dir = head.clone().sub(foot).normalize();
      const log = new THREE.Mesh(logGeo, logMat);
      log.quaternion.setFromUnitVectors(up, dir);
      log.position.copy(foot).lerp(head, 0.5);
      log.castShadow = true;
      log.receiveShadow = true;
      scene.add(log);
    }

    // ---- 炎と火の粉 ----
    const flame = helpers.makeFlame(THREE, scene, {
      layers: 3,
      width: 1.15,
      height: 1.9,
      position: new THREE.Vector3(0, 0.12, 0),
      camera,
      embers: { max: 400 },
    });

    // 炎の光：点光源（影つき）＋ もやに滲むハロー
    const fireLight = new THREE.PointLight(0xff9a3c, 2.2, 22, 1.7);
    fireLight.position.set(0, 0.9, 0);
    fireLight.castShadow = true;
    fireLight.shadow.mapSize.set(512, 512);
    fireLight.shadow.bias = -0.004;
    scene.add(fireLight);

    const haloCanvas = document.createElement('canvas');
    haloCanvas.width = haloCanvas.height = 128;
    const hctx = haloCanvas.getContext('2d');
    const grad = hctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,170,80,0.55)');
    grad.addColorStop(0.35, 'rgba(255,120,40,0.18)');
    grad.addColorStop(1, 'rgba(255,90,20,0)');
    hctx.fillStyle = grad;
    hctx.fillRect(0, 0, 128, 128);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(haloCanvas),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    halo.position.set(0, 0.9, 0);
    scene.add(halo);

    // 星明かり程度の環境光
    scene.add(new THREE.HemisphereLight(0x101a30, 0x000000, 0.28));

    // ---- 遠景：木立のシルエット ----
    const treeMat = new THREE.MeshStandardMaterial({ color: 0x05080c, roughness: 1 });
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 16 + Math.random() * 14;
      const h = 4 + Math.random() * 6;
      const tree = new THREE.Mesh(new THREE.ConeGeometry(h * 0.28, h, 7), treeMat);
      tree.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
      scene.add(tree);
    }

    // ---- 星 ----
    const starCount = 500;
    const sp = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const u = Math.random(), v = Math.random();
      const th = u * Math.PI * 2;
      const phi = Math.acos(1 - v) * 0.5; // 上半球
      const R = 90;
      sp[i * 3] = R * Math.sin(phi) * Math.cos(th);
      sp[i * 3 + 1] = R * Math.cos(phi);
      sp[i * 3 + 2] = R * Math.sin(phi) * Math.sin(th);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xcfd8ee, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.7, fog: false, depthWrite: false,
    }));
    scene.add(stars);

    // ---- 草：焚き火のまわりの野原。石の囲いの内側には生えない ----
    const grass = helpers.makeGrass(THREE, scene, {
      count: 900,
      place: () => {
        const a = Math.random() * Math.PI * 2;
        const r = 1.9 + Math.pow(Math.random(), 0.8) * 13;
        return [Math.cos(a) * r, Math.sin(a) * r];
      },
      clusters: { count: 40, radius: 1.5, ratio: 0.7 },
      height: [0.25, 0.65],
      bladeWidth: 0.07,
      spread: 0.35,
      color: 0x33482a,
      roughness: 0.9,
    });
    const sway = reduceMotion ? 0.35 : 1;

    return {
      update(dt, t, p) {
        flame.update(dt, t, { power: p.power, wind: p.wind, embers: p.embers });
        if (flame.embers) flame.embers.setScale(renderer.domElement.height * 0.5);
        grass.update(dt, t, { wind: p.wind, sway });

        // 光は炎と同じ拍で明滅し、わずかに位置も揺れる（影が動く）
        const f = flame.flicker.value;
        const pw = Math.pow(p.power, 0.7);
        fireLight.intensity = 2.2 * pw * f;
        fireLight.distance = 16 + 8 * pw;
        fireLight.position.set(Math.sin(t * 7.3) * 0.06, 0.7 + 0.5 * pw, Math.cos(t * 5.9) * 0.06);
        halo.material.opacity = 0.9 * f * Math.min(1, pw);
        const hs = 3.2 + 2.2 * pw;
        halo.scale.set(hs, hs, 1);
        bed.material.opacity = 0.22 + 0.16 * pw * (0.85 + Math.sin(t * 2.1) * 0.15);

        // ゆっくりしたカメラの揺れ
        if (!reduceMotion) {
          camera.position.x = camBase.x + Math.sin(t * 0.16) * 0.9;
          camera.position.y = camBase.y + Math.sin(t * 0.23) * 0.12;
          camera.lookAt(camAim);
        }
      },
    };
  },
});
