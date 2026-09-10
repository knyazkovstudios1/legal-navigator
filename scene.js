/* 3D-сцена первого экрана: поток вопросов проходит проверку и расходится
 * на три ветки. Это не абстрактный декор — на сцене показана та самая
 * логика, о которой говорит страница.
 *
 * Требования, которым сцена подчинена:
 *  - падение сцены не должно ломать страницу: всё в try, при ошибке остаётся
 *    статичный градиент;
 *  - на слабой машине и при prefers-reduced-motion сцена не запускается;
 *  - при скрытой вкладке кадры не считаются.
 */
(function () {
  'use strict';

  var host = document.getElementById('scene');
  if (!host) return;

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { host.dataset.state = 'reduced'; return; }
  if (!window.THREE) { host.dataset.state = 'nolib'; return; }

  // WebGL может быть недоступен: удалённый рабочий стол, старый драйвер,
  // проектор с программным рендерингом. Проверяем до создания рендерера.
  try {
    var probe = document.createElement('canvas');
    if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) {
      host.dataset.state = 'nowebgl';
      return;
    }
  } catch (e) { host.dataset.state = 'nowebgl'; return; }

  var THREE = window.THREE;
  var COLORS = { ask: 0x7ba5f2, gate: 0xe6ecf8, a: 0x2fd0bd, b: 0xf0b64a, v: 0xf07f8c };

  var renderer, scene, camera, raf = null, t = 0;
  var groups = {};

  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(46, host.clientWidth / host.clientHeight, 0.1, 100);
    camera.position.set(0, 1.1, 13);
    camera.lookAt(0, 0, 0);
  } catch (e) {
    host.dataset.state = 'failed';
    return;
  }

  // ---------- пути ----------
  // Один входящий путь до ворот, затем три расходящихся.
  function curve(points) {
    return new THREE.CatmullRomCurve3(points.map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]); }));
  }

  var GATE = [0, 0, 0];
  var paths = [
    { key: 'in', color: COLORS.ask, curve: curve([[-11, 0, 0], [-7, 0.35, 0.6], [-3.4, 0.1, 0], GATE]), share: 1 },
    { key: 'a', color: COLORS.a, curve: curve([GATE, [3.2, 1.9, -0.4], [7, 2.7, 0.3], [11, 3.1, 0]]), share: 0.42 },
    { key: 'b', color: COLORS.b, curve: curve([GATE, [3.4, 0.05, 0.5], [7.2, -0.1, -0.3], [11, 0, 0]]), share: 0.28 },
    { key: 'v', color: COLORS.v, curve: curve([GATE, [3.2, -1.9, -0.5], [7, -2.7, 0.2], [11, -3.1, 0]]), share: 0.30 },
  ];

  // Линии путей — тонкие, чтобы читались как направляющие, а не как объект.
  paths.forEach(function (p) {
    var geo = new THREE.BufferGeometry().setFromPoints(p.curve.getPoints(90));
    var mat = new THREE.LineBasicMaterial({ color: p.color, transparent: true, opacity: p.key === 'in' ? 0.28 : 0.22 });
    scene.add(new THREE.Line(geo, mat));
  });

  // ---------- частицы ----------
  var PARTICLES = 260;
  var particles = [];
  var pos = new Float32Array(PARTICLES * 3);
  var col = new Float32Array(PARTICLES * 3);
  var tmp = new THREE.Color();

  function assignPath() {
    // Доли примерно отражают реальное распределение по веткам.
    var r = Math.random();
    if (r < 0.42) return paths[1];
    if (r < 0.70) return paths[2];
    return paths[3];
  }

  for (var i = 0; i < PARTICLES; i++) {
    particles.push({
      stage: 'in',
      path: paths[0],
      next: assignPath(),
      t: Math.random(),
      speed: 0.0016 + Math.random() * 0.0022,
      wob: Math.random() * Math.PI * 2,
    });
  }

  var pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  var pMat = new THREE.PointsMaterial({
    size: 0.11, vertexColors: true, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  scene.add(new THREE.Points(pGeo, pMat));

  // ---------- ворота проверки ----------
  var gate = new THREE.Group();
  var ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.05, 0.035, 12, 90),
    new THREE.MeshBasicMaterial({ color: COLORS.gate, transparent: true, opacity: 0.55 })
  );
  var ring2 = new THREE.Mesh(
    new THREE.TorusGeometry(1.5, 0.012, 10, 90),
    new THREE.MeshBasicMaterial({ color: COLORS.ask, transparent: true, opacity: 0.3 })
  );
  ring2.rotation.x = Math.PI / 2.4;
  var core = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.42, 0),
    new THREE.MeshBasicMaterial({ color: COLORS.gate, wireframe: true, transparent: true, opacity: 0.75 })
  );
  gate.add(ring, ring2, core);
  scene.add(gate);
  groups.gate = gate;

  // ---------- фоновая пыль ----------
  var dustCount = 340;
  var dpos = new Float32Array(dustCount * 3);
  for (var d = 0; d < dustCount; d++) {
    dpos[d * 3] = (Math.random() - 0.5) * 34;
    dpos[d * 3 + 1] = (Math.random() - 0.5) * 18;
    dpos[d * 3 + 2] = (Math.random() - 0.5) * 16 - 6;
  }
  var dGeo = new THREE.BufferGeometry();
  dGeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
  var dust = new THREE.Points(dGeo, new THREE.PointsMaterial({
    size: 0.035, color: 0x8ea6d8, transparent: true, opacity: 0.35, depthWrite: false,
  }));
  scene.add(dust);

  // ---------- мышь ----------
  var mx = 0, my = 0, tmx = 0, tmy = 0;
  window.addEventListener('pointermove', function (e) {
    tmx = (e.clientX / window.innerWidth - 0.5) * 2;
    tmy = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  // ---------- цикл ----------
  var v3 = new THREE.Vector3();

  function frame() {
    t += 1;
    mx += (tmx - mx) * 0.045;
    my += (tmy - my) * 0.045;

    for (var i = 0; i < PARTICLES; i++) {
      var p = particles[i];
      p.t += p.speed;

      if (p.t >= 1) {
        p.t = 0;
        if (p.stage === 'in') {
          p.stage = 'out';
          p.path = p.next;
        } else {
          p.stage = 'in';
          p.path = paths[0];
          p.next = assignPath();
        }
      }

      p.path.curve.getPoint(p.t, v3);
      // Лёгкое дрожание, чтобы поток не выглядел механическим.
      var w = Math.sin(t * 0.02 + p.wob) * 0.075;
      pos[i * 3] = v3.x;
      pos[i * 3 + 1] = v3.y + w;
      pos[i * 3 + 2] = v3.z + Math.cos(t * 0.017 + p.wob) * 0.075;

      // У ворот частица разгорается — видно, что там происходит проверка.
      var near = 1 - Math.min(Math.abs(v3.x) / 3.2, 1);
      tmp.setHex(p.path.color);
      var boost = 0.55 + near * 0.9;
      col[i * 3] = Math.min(tmp.r * boost, 1);
      col[i * 3 + 1] = Math.min(tmp.g * boost, 1);
      col[i * 3 + 2] = Math.min(tmp.b * boost, 1);
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;

    gate.rotation.y = t * 0.006;
    gate.rotation.z = Math.sin(t * 0.008) * 0.16;
    core.rotation.x = t * 0.013;
    core.rotation.y = -t * 0.017;
    var pulse = 1 + Math.sin(t * 0.03) * 0.05;
    ring.scale.setScalar(pulse);

    dust.rotation.y = t * 0.0006;

    camera.position.x = mx * 1.1;
    camera.position.y = 1.1 - my * 0.7;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  function start() { if (raf === null) raf = requestAnimationFrame(frame); }
  function stop() { if (raf !== null) { cancelAnimationFrame(raf); raf = null; } }

  // Кадры не считаются, когда вкладка скрыта или сцена ушла с экрана.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) start(); else stop(); });
    }, { threshold: 0.01 }).observe(host);
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!host.clientWidth || !host.clientHeight) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    }, 150);
  });

  host.dataset.state = 'on';
  start();
})();
