/* 街灯の夜雨 — 濡れたアスファルトに街灯が映る、夜の雨。 */
madobe.register({
  id: 'night-rain',
  name: '街灯の夜雨',
  meta: 'rain · night · streetlamp',
  params: [
    { key: 'count', label: '雨量',     min: 200, max: 3000, step: 100, value: 1800 },
    { key: 'wind',  label: '風',       min: -6,  max: 6,    step: 0.5, value: 1.5 },
    { key: 'speed', label: '落下速度', min: 10,  max: 40,   step: 1,   value: 26 },
  ],

  create({ THREE, renderer, scene, camera, reduceMotion, helpers }) {
    renderer.shadowMap.enabled = true;
    renderer.toneMappingExposure = 1.1;

    scene.background = new THREE.Color(0x05070c);
    scene.fog = new THREE.FogExp2(0x05070c, 0.045);

    camera.near = 0.1;
    camera.far = 200;
    camera.updateProjectionMatrix();
    const camBase = new THREE.Vector3(0, 3.2, 14);
    camera.position.copy(camBase);
    camera.lookAt(0, 2.5, 0);

    // ---- 地面：濡れたアスファルト（低 roughness で光を映す）----
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: 0x0c1119, roughness: 0.18, metalness: 0.55 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // ---- 街灯 ----
    const lampGroup = new THREE.Group();
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x1c2129, roughness: 0.6, metalness: 0.5 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 7, 16), poleMat);
    pole.position.y = 3.5;
    pole.castShadow = true;
    lampGroup.add(pole);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 12), poleMat);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(0.8, 6.95, 0);
    lampGroup.add(arm);
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.45, 24, 1, true), poleMat);
    hood.position.set(1.55, 6.8, 0);
    lampGroup.add(hood);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0xffe2a8 })
    );
    bulb.position.set(1.55, 6.6, 0);
    lampGroup.add(bulb);
    lampGroup.position.set(-1.5, 0, 0);
    scene.add(lampGroup);

    const lampLight = new THREE.PointLight(0xffc978, 2.2, 30, 1.6);
    lampLight.position.set(0.05, 6.55, 0);
    lampLight.castShadow = true;
    lampLight.shadow.mapSize.set(1024, 1024);
    scene.add(lampLight);

    const spot = new THREE.SpotLight(0xffd090, 1.6, 26, Math.PI / 4.5, 0.6, 1.2);
    spot.position.set(0.05, 6.7, 0);
    spot.target.position.set(0.05, 0, 0);
    scene.add(spot, spot.target);

    // 空からのかすかな冷たい環境光
    scene.add(new THREE.HemisphereLight(0x1a2438, 0x05070c, 0.35));

    // ---- ハロー：雨のもやに滲む光（加算合成のスプライト）----
    const haloCanvas = document.createElement('canvas');
    haloCanvas.width = haloCanvas.height = 128;
    const hctx = haloCanvas.getContext('2d');
    const grad = hctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,220,160,0.9)');
    grad.addColorStop(0.25, 'rgba(255,200,120,0.35)');
    grad.addColorStop(1, 'rgba(255,190,100,0)');
    hctx.fillStyle = grad;
    hctx.fillRect(0, 0, 128, 128);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(haloCanvas),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    halo.scale.set(4.5, 4.5, 1);
    halo.position.set(0.05, 6.6, 0);
    scene.add(halo);

    // ---- 遠景のビル（奥行きのためのシルエット）----
    const bldgMat = new THREE.MeshStandardMaterial({ color: 0x090c13, roughness: 0.9 });
    [[-14, 12, 6, -18], [10, 9, 8, -22], [-4, 15, 5, -26], [18, 7, 7, -16]].forEach(([x, h, w, z]) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 5), bldgMat);
      b.position.set(x, h / 2, z);
      scene.add(b);
    });

    // ---- 雨と波紋 ----
    const rain = helpers.makeRain(THREE, scene, {
      max: 3000,
      area: { x: 30, z: 30, top: 18 },
      color: 0xaebcd6,
      opacity: 0.55,
    });
    const ripples = helpers.makeRipples(THREE, scene, {
      count: 60,
      color: 0xc9d6ea,
      maxOpacity: 0.35,
      speed: 1.4,
    });
    // 着地した粒の 6% が街灯周辺で波紋を出す
    const onLand = (x, z) => {
      if (Math.random() < 0.06 && Math.abs(x) < 12 && Math.abs(z) < 12) ripples.spawn(x, z);
    };

    return {
      update(dt, t, p) {
        rain.update(dt, p, onLand);
        ripples.update(dt);

        // 街灯の明滅（sin 2本の合成）
        const flick = 1 + Math.sin(t * 13.1) * 0.03 + Math.sin(t * 31.7) * 0.02;
        lampLight.intensity = 2.2 * flick;
        halo.material.opacity = 0.85 * flick;

        // ゆっくりしたカメラの揺れ
        if (!reduceMotion) {
          camera.position.x = camBase.x + Math.sin(t * 0.18) * 1.2;
          camera.position.y = camBase.y + Math.sin(t * 0.27) * 0.25;
          camera.lookAt(0, 2.5, 0);
        }
      },
    };
  },
});
