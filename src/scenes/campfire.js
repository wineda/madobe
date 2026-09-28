/* 焚き火 — 夜の野原で、ゆらゆら揺れる炎を眺める。
 * 炎・火の粉・煙は helpers.makeFlame、ブルームと陽炎は helpers.makePost。 */
madobe.register({
  id: 'campfire',
  name: '焚き火',
  meta: 'fire · night · field',
  params: [
    { key: 'power',  label: '火の勢い', min: 0.2, max: 2,   step: 0.1, value: 1 },
    { key: 'wind',   label: '風',       min: -4,  max: 4,   step: 0.5, value: 0.5 },
    { key: 'embers', label: '火の粉',   min: 0,   max: 400, step: 20,  value: 160 },
    { key: 'smoke',  label: '煙',       min: 0,   max: 160, step: 10,  value: 70 },
  ],

  create({ THREE, renderer, scene, camera, reduceMotion, helpers }) {
    renderer.shadowMap.enabled = true;
    // HDR のまま RT に描き、トーンマッピングは makePost の合成パスで掛ける（app 側が切替時に戻す）
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 0.95;

    // 合成パスで sRGB 変換されるので、背景と霧はリニア値としてかなり暗めに指定する
    scene.background = new THREE.Color(0x010203);
    scene.fog = new THREE.FogExp2(0x010203, 0.05);

    camera.near = 0.1;
    camera.far = 200;
    camera.updateProjectionMatrix();
    const camBase = new THREE.Vector3(0, 1.5, 6.2);
    const camAim = new THREE.Vector3(0, 0.85, 0);
    camera.position.copy(camBase);
    camera.lookAt(camAim);

    // ---- 地面：乾いた土。Canvas で作ったノイズを色とバンプに使う ----
    const texCanvas = document.createElement('canvas');
    texCanvas.width = texCanvas.height = 256;
    const tctx = texCanvas.getContext('2d');
    const img = tctx.createImageData(256, 256);
    // 粗いむら（バイリニア補間したランダム格子。端はループさせて継ぎ目を消す）と細かい粒を重ねる
    const gridN = 16;
    const grid = new Float32Array(gridN * gridN);
    for (let i = 0; i < grid.length; i++) grid[i] = Math.random();
    const coarseAt = (x, y) => {
      const gx = (x / 256) * gridN, gy = (y / 256) * gridN;
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const fx = gx - x0, fy = gy - y0;
      const g = (a, b) => grid[((b % gridN) + gridN) % gridN * gridN + ((a % gridN) + gridN) % gridN];
      return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
    };
    for (let i = 0; i < 256 * 256; i++) {
      const x = i % 256, y = (i / 256) | 0;
      const v = 96 + (coarseAt(x, y) - 0.5) * 90 + (Math.random() - 0.5) * 60;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = Math.max(0, Math.min(255, v));
      img.data[i * 4 + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
    const groundTex = new THREE.CanvasTexture(texCanvas);
    groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
    groundTex.repeat.set(20, 20);
    groundTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({
        color: 0x4a3524, map: groundTex, bumpMap: groundTex, bumpScale: 0.04, roughness: 0.95, metalness: 0,
      })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // 焚き火の下の灰と焦げ跡
    const ash = new THREE.Mesh(
      new THREE.CircleGeometry(0.95, 40),
      new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 1, metalness: 0 })
    );
    ash.rotation.x = -Math.PI / 2;
    ash.position.y = 0.012;
    ash.receiveShadow = true;
    scene.add(ash);

    // 燃え残りの熾（おき）。HDR の赤で脈打ち、ブルームで滲む
    const bedColor = new THREE.Color(0xff6a1a);
    const bed = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 32),
      new THREE.MeshBasicMaterial({ color: bedColor.clone(), transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    bed.rotation.x = -Math.PI / 2;
    bed.position.y = 0.02;
    scene.add(bed);

    // ---- 石の囲い：多面体の頂点を位置ハッシュでランダムに凹凸させて岩らしく ----
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x3b3835, roughness: 0.92, metalness: 0.02, flatShading: true });
    const rockGeometry = (seed) => {
      const g = new THREE.IcosahedronGeometry(0.27, 1);
      const pos = g.attributes.position;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const hsh = Math.abs(Math.sin(v.x * 12.9 + seed) * 43758.5 + Math.sin(v.y * 78.2 - seed) * 1234.5 + Math.sin(v.z * 37.7) * 99.1) % 1;
        v.multiplyScalar(0.78 + hsh * 0.42);
        pos.setXYZ(i, v.x, v.y * 0.7, v.z);
      }
      g.computeVertexNormals();
      return g;
    };
    const stones = 14;
    for (let i = 0; i < stones; i++) {
      const a = (i / stones) * Math.PI * 2 + (Math.random() - 0.5) * 0.22;
      const r = 1.1 + (Math.random() - 0.5) * 0.14;
      const s = new THREE.Mesh(rockGeometry(i * 3.7), stoneMat);
      const k = 0.8 + Math.random() * 0.5;
      s.scale.setScalar(k);
      s.position.set(Math.cos(a) * r, 0.12 * k, Math.sin(a) * r);
      s.rotation.set(0, Math.random() * Math.PI, 0);
      s.castShadow = true;
      s.receiveShadow = true;
      scene.add(s);
    }

    // ---- 薪：3本を地面から中心へ傾けて組む。炎に近い上部は熱で赤く光る ----
    const logMat = new THREE.MeshStandardMaterial({
      color: 0x2b1a10, roughness: 0.9, metalness: 0,
      emissive: 0xff3c08, emissiveIntensity: 0,
    });
    // 発光を薪の上端（頂点 y が大きい側）だけに絞る
    logMat.onBeforeCompile = (shader) => {
      shader.vertexShader = 'varying float vGlow;\n' + shader.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vGlow = smoothstep(-0.1, 0.62, position.y);');
      shader.fragmentShader = 'varying float vGlow;\n' + shader.fragmentShader
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance *= vGlow * vGlow;');
    };
    logMat.customProgramCacheKey = () => 'madobe-campfire-log';
    const logGeo = new THREE.CylinderGeometry(0.1, 0.125, 1.35, 12);
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

    // ---- 炎・火の粉・煙 ----
    const flamePos = new THREE.Vector3(0, 0.1, 0);
    const flame = helpers.makeFlame(THREE, scene, {
      layers: 4,
      width: 1.15,
      height: 2.1,
      bright: 1.7,
      position: flamePos,
      camera,
      embers: { max: 400 },
      smoke: { max: 160, tint: 0x6a3216, opacity: 0.16 },
    });

    // 炎の光：影つきの点光源。色は温度感のある橙
    const fireLight = new THREE.PointLight(0xff9440, 2.6, 24, 2);
    fireLight.position.set(0, 0.9, 0);
    fireLight.castShadow = true;
    fireLight.shadow.mapSize.set(512, 512);
    fireLight.shadow.bias = -0.004;
    scene.add(fireLight);
    // 足元を照らす補助光（影なし）。炎が地面へ直接落とす照り返し
    const fillLight = new THREE.PointLight(0xff7a2a, 0.35, 5, 2);
    fillLight.position.set(0, 0.5, 0);
    scene.add(fillLight);

    // 星明かり程度の環境光
    scene.add(new THREE.HemisphereLight(0x0e1730, 0x000000, 0.18));

    // ---- 遠景：木立のシルエット ----
    const treeMat = new THREE.MeshStandardMaterial({ color: 0x010203, roughness: 1 });
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 15 + Math.random() * 15;
      const h = 4 + Math.random() * 7;
      const tree = new THREE.Mesh(new THREE.ConeGeometry(h * 0.26, h, 7), treeMat);
      tree.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
      scene.add(tree);
    }

    // ---- 星 ----
    const starCount = 600;
    const sp = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const th = Math.random() * Math.PI * 2;
      const phi = Math.acos(1 - Math.random()) * 0.5; // 上半球
      const R = 90;
      sp[i * 3] = R * Math.sin(phi) * Math.cos(th);
      sp[i * 3 + 1] = R * Math.cos(phi);
      sp[i * 3 + 2] = R * Math.sin(phi) * Math.sin(th);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xb9c4dd, size: 1.5, sizeAttenuation: false, transparent: true, opacity: 0.55, fog: false, depthWrite: false,
    }));
    scene.add(stars);

    // ---- ポストエフェクト：ブルーム＋陽炎＋トーンマッピング ----
    const post = helpers.makePost(THREE, renderer, { bloom: 0.75, threshold: 0.9, vignette: 0.4 });
    const hazeWorld = new THREE.Vector3();
    const haze = { x: 0.5, y: 0.5, width: 0.13, height: 0.4, strength: 0 };

    let time = 0;
    let power = 1;

    return {
      update(dt, t, p) {
        time = t;
        power = p.power;
        flame.update(dt, t, {
          power: p.power, wind: p.wind, embers: p.embers, smoke: p.smoke,
          pixelHeight: renderer.domElement.height,
        });

        // 光は炎と同じ拍で明滅し、わずかに位置も揺れる（影が動く）
        const f = flame.flicker.value;
        const pw = Math.pow(p.power, 0.7);
        fireLight.intensity = 2.6 * pw * f;
        fireLight.distance = 18 + 8 * pw;
        fireLight.position.set(Math.sin(t * 7.3) * 0.06, 0.65 + 0.5 * pw, Math.cos(t * 5.9) * 0.06);
        fillLight.intensity = 0.35 * pw * f;
        bed.material.opacity = (0.12 + 0.12 * pw) * (0.85 + Math.sin(t * 2.1) * 0.1 + (f - 1) * 0.6);
        bed.material.color.copy(bedColor).multiplyScalar(1.3);
        logMat.emissiveIntensity = (0.35 + 0.55 * pw) * (0.8 + (f - 1) * 1.5);

        // ゆっくりしたカメラの揺れ
        if (!reduceMotion) {
          camera.position.x = camBase.x + Math.sin(t * 0.16) * 0.8;
          camera.position.y = camBase.y + Math.sin(t * 0.23) * 0.1;
          camera.lookAt(camAim);
        }
      },
      render(renderer, scene, camera) {
        // 陽炎の位置：炎の少し上を画面座標に投影
        hazeWorld.set(0, flamePos.y + 1.2 * Math.pow(power, 0.6), 0).project(camera);
        haze.x = hazeWorld.x * 0.5 + 0.5;
        haze.y = hazeWorld.y * 0.5 + 0.5;
        haze.width = 0.11 + 0.05 * power;
        haze.height = 0.35 + 0.15 * power;
        haze.strength = reduceMotion ? 0.003 : 0.008 * Math.pow(power, 0.5);
        post.render(scene, camera, { time, haze });
      },
      dispose() {
        post.dispose();
        groundTex.dispose();
      },
    };
  },
});
