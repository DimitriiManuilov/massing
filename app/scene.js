/* ============================================================
   Трёхмерная сцена: свет, материалы, камера, постобработка.

   Эстетика — «серый массинг»: белёсые объёмы, рассеянный свет
   пасмурного неба, мягкая направленная тень, объёмное затенение
   в примыканиях. Читается морфология, а не отделка.

   Плавность держится на трёх приёмах: кадр считается только когда
   что-то изменилось; во время вращения качество временно падает и
   восстанавливается в покое; карта теней пересчитывается лишь при
   смене солнца.
   ============================================================ */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { TiltShiftShader } from './postfx.js';
import { sunVector } from './sun.js';
import { terrainAt } from './terrain.js';

const BG = 0xeceae5;
const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// Склейка нескольких простых форм в одну геометрию: у инстанса может
// быть только одна, а машина и фонарь состоят из пары коробок.
function mergeShapes(list) {
  const parts = list.map(g => (g.index ? g.toNonIndexed() : g));
  const total = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, c * 3), o * 3);
    nrm.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    o += c;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return out;
}

export class Viewer {
  constructor(container) {
    this.container = container;
    this.extent = 1000;
    this.aoOn = true;
    this.tiltOn = true;
    this._hi = true;
    this.fps = 0;
    this.orbit = false;
    this.orbitSpeed = 1;

    this.renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.maxPR = Math.min(devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.maxPR);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;      // тени пересчитываем сами
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Клеевой макет почти не даёт провалов в тенях: заливка неба
    // сильная, солнце умеренное, вся светотень держится на затенении
    // в примыканиях. Слишком тёмная тень на кровле сразу выдаёт
    // компьютерную картинку — в натурном макете её нечем создать.
    this.renderer.toneMappingExposure = 0.94;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.environment = this.makeSkyEnv();
    // Керн конечен, поэтому дымка больше не нужна: вместо неё —
    // пустой градиентный фон, в котором объект висит как макет.
    this.scene.background = this.makeBackdrop();

    this.persp = new THREE.PerspectiveCamera(38, 1, 1, 12000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 40000);
    this.camera = this.persp;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;

    // Нижний цвет полусферы светлее, чем было у бесконечной земли:
    // теперь снизу не грунт, а пустой задник, и толща керна иначе
    // проваливается в черноту.
    this.hemi = new THREE.HemisphereLight(0xe8ebee, 0xd6d1c8, 0.68);
    this.scene.add(this.hemi);

    // Контровой свет напротив солнца: холодная кромка отделяет объём
    // от фона — без неё силуэт керна сливается с задником.
    this.rim = new THREE.DirectionalLight(0xc6d2dc, 0.38);
    this.scene.add(this.rim);

    this.sun = new THREE.DirectionalLight(0xfff6e8, 1.55);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    // Сдвиг по нормали меньше: с тесной рамкой самозатенение уже не
    // лезет, а большой сдвиг отрывал тень от стены у основания.
    this.sun.shadow.normalBias = 0.35;
    this.sun.shadow.radius = 2.5;
    this.scene.add(this.sun, this.sun.target);

    this.groups = {};
    for (const n of ['ground', 'roads', 'green', 'water', 'buildings',
                     'trees', 'cars', 'lamps', 'fences', 'proposal', 'highlight',
                     'paved', 'annot', 'marks', 'insol']) {
      this.groups[n] = new THREE.Group();
      this.scene.add(this.groups[n]);
    }

    /* --- постобработка ---
       GTAO вместо прежнего SSAO: затенение честнее по горизонту,
       заметно чище на плоских кровлях и дешевле при том же радиусе.
       В отличие от SSAOPass он не рендерит сцену сам, поэтому
       RenderPass впереди обязателен. */
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);

    this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.9;
    this.gtao.updateGtaoMaterial({
      radius: 14,              // метры: масштаб затенения в примыканиях
      distanceExponent: 1.2,
      thickness: 6,
      scale: 1.0,
      samples: 12
    });
    this.gtao.updatePdMaterial({ lumaPhi: 8, depthPhi: 2.5, normalPhi: 4, radius: 5, samples: 8 });

    this.smaa = new SMAAPass(1, 1);
    this.tilt = new ShaderPass(TiltShiftShader);

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.gtao);
    this.composer.addPass(this.smaa);
    this.composer.addPass(this.tilt);
    this.composer.addPass(new OutputPass());

    this.raycaster = new THREE.Raycaster();
    this.needsRender = true;
    this.tween = null;

    // Во время вращения кадр важнее пикселей: срезаем разрешение и
    // постобработку, а в покое возвращаем полное качество.
    let idle;
    this.controls.addEventListener('start', () => { clearTimeout(idle); this.setQuality(false); });
    this.controls.addEventListener('end', () => {
      clearTimeout(idle);
      idle = setTimeout(() => this.setQuality(true), 160);
    });
    this.controls.addEventListener('change', () => { this.needsRender = true; });

    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize);

    // В фоновой вкладке браузер замораживает кадры: если сцену собрали
    // в это время, полотно остаётся пустым до первой перерисовки.
    // Возвращаемся на вкладку — сразу рисуем заново.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      this.resize();
      this.renderer.shadowMap.needsUpdate = true;
      this.needsRender = true;
    });
    this.resize();
    this.animate();
  }

  /* Мягкое небо градиентом вместо HDRI: ровный «студийный» свет
     без внешних файлов и без лицензионных хвостов. */
  /* Задник: мягкий вертикальный градиент вместо плоской заливки.
     Он вращается вместе с камерой, поэтому керн всегда стоит в
     «студии», с какой стороны на него ни смотри. */
  makeBackdrop() {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.00, '#dcdcd9');
    g.addColorStop(0.42, '#eceae5');
    g.addColorStop(0.62, '#e6e3dc');
    g.addColorStop(1.00, '#b8b4ab');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 8, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  makeSkyEnv() {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.00, '#c9d8e8');
    g.addColorStop(0.45, '#e9eef3');
    g.addColorStop(0.52, '#e6e2da');
    g.addColorStop(1.00, '#9c968c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 256);

    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromEquirectangular(tex).texture;
    pmrem.dispose(); tex.dispose();
    return env;
  }

  // Во время вращения качество временно падает: разрешение вниз,
  // затенение и сглаживание выключены. Кадр важнее пикселей, пока
  // модель крутится; в покое всё возвращается.
  setQuality(hi) {
    if (hi === this._hi) return;
    this._hi = hi;
    const pr = hi ? this.maxPR : Math.max(0.75, this.maxPR * 0.6);
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.gtao.enabled = hi && this.aoOn;
    this.smaa.enabled = hi;
    this.tilt.enabled = hi && this.tiltOn;
    this.needsRender = true;
  }

  /* ---------- наполнение сцены ---------- */

  clear() {
    for (const g of Object.values(this.groups)) {
      g.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
      });
      g.clear();
    }
    this.buildingMesh = null;
    this.pickMesh = null;
    this.hoverMesh = null;
    this._hoverKey = -1;
    this.index = [];
    this._baseColors = null;
    this.proposal = [];
  }

  setSite(site, terrain) {
    this.site = site;
    this.terrain = terrain;
    this.extent = site.radius * 2;
    const relief = terrain ? Math.max(20, terrain.max - terrain.min) : 0;

    // Отдельная линия границы больше не нужна: кромка керна сама
    // очерчивает участок.
    this.updateFog();
    this.persp.far = this.extent * 12 + relief * 4;
    this.persp.updateProjectionMatrix();
    this.setView('iso', 0);
  }

  // Керн: сверху грунт с рельефом, по краю — толща, снизу дно.
  // Толщу делаем темнее и теплее верха: срез читается как порода,
  // а сам участок — как вынутый из города образец.
  setCore(core) {
    if (!core) return;
    const mk = (arr, color, roughness) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      geo.computeVertexNormals();
      return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 }));
    };

    const top = mk(core.top, 0xc2bfba, 1.0);
    top.receiveShadow = true;
    this.groups.ground.add(top);
    this.coreTop = top;              // по нему наводится разметка

    // Толщу намеренно выводим из расчёта теней: на вертикальный срез
    // проецировались силуэты зданий, и порода выглядела запачканной.
    const shell = mk(core.shell, 0xa9a6a1, 0.95);
    shell.receiveShadow = false;
    this.groups.ground.add(shell);

    this.coreBottom = core.bottomY;
    this.needsRender = true;
  }

  setBuildings(b) {
    if (!b) return;
    this.index = b.index;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(b.colors, 3));
    if (b.bases) geo.setAttribute('aBottom', new THREE.BufferAttribute(b.bases, 1));
    if (b.delays) geo.setAttribute('aDelay', new THREE.BufferAttribute(b.delays, 1));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0, color: 0xffffff
    });

    // Рост объёмов делаем в вершинном шейдере: вся застройка — один
    // меш, и подниматься она должна без пересборки геометрии на
    // каждом кадре. Тени идут из того же материала, поэтому растут
    // вместе со зданиями.
    this.grow = { value: 1 };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGrow = this.grow;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uGrow;
          attribute float aBottom;
          attribute float aDelay;
          varying vec3 vWorld;
          varying float vAbove;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float g = clamp((uGrow - aDelay) / 0.45, 0.0, 1.0);
          g = 1.0 - pow(1.0 - g, 3.0);
          transformed.y = mix(aBottom, transformed.y, g);
          vWorld = transformed;
          vAbove = transformed.y - aBottom;   // высота над низом объёма`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWorld;
          varying float vAbove;

          /* Зерно поверхности. Значимый шум на трёх частотах: одна
             задаёт крупные разводы отливки, две другие — собственно
             зернистость гипса. Считается по мировым координатам,
             поэтому не тянется по граням и одинаково выглядит на
             стене и на кровле. */
          float hash13(vec3 p){
            p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
            p += dot(p, p.yzx + 19.19);
            return fract((p.x + p.y) * p.z);
          }
          float vnoise(vec3 p){
            vec3 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float n000 = hash13(i), n100 = hash13(i + vec3(1,0,0));
            float n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
            float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1));
            float n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
            return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
                       mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
          }`)

        .replace('#include <color_fragment>', `#include <color_fragment>
          /* Материал макета.

             Плоский цвет с постоянной шероховатостью выглядит
             пластиком: настоящая поверхность отлитого макета
             неоднородна, у основания стен темнее от пыли, а свет по
             ней ложится не идеально ровно. Всё это — доли процента
             яркости, но именно из них складывается ощущение вещи, а
             не картинки.

             Ничего не рисуется: нет ни окон, ни линий, ни рисунка.
             Меняется только тон поверхности. */
          /* Частоты подобраны под то расстояние, с которого на модель
             смотрят. Мелкое зерно в полметра честнее физически, но на
             экране оно усредняется в ровную заливку и не даёт ничего:
             читаются разводы в несколько метров — те самые пятна
             отливки, которые видно на настоящем макете с двух шагов. */
          /* Две октавы вместо трёх. Каждая — восемь хешей на фрагмент,
             и третья стоила пять миллисекунд кадра, а на глаз после
             перебалансировки не давала ничего: её частота всё равно
             тонула при уменьшении. */
          float grain = vnoise(vWorld * 0.14) * 0.68
                      + vnoise(vWorld * 0.62) * 0.32;
          grain = clamp((grain - 0.5) * 2.2, -1.0, 1.0);   // растягиваем к краям
          // Пять процентов не видно вовсе, пятьдесят превращают гипс
          // в бетон под дождём. Шестнадцать — та мера, на которой
          // поверхность перестаёт быть заливкой, но остаётся макетом.
          diffuseColor.rgb *= 1.0 + grain * 0.16;

          // Пыль у основания: метр снизу заметно темнее, как на макете,
          // который не первый месяц стоит на столе.
          diffuseColor.rgb *= 1.0 - 0.16 * exp(-max(vAbove, 0.0) * 1.1);`)

        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          // Шероховатость гуляет вместе с зерном: ровная по всей
          // площади она и даёт то самое «пластиковое» отражение.
          roughnessFactor = clamp(roughnessFactor + grain * 0.10, 0.55, 1.0);`);
    };
    mat.customProgramCacheKey = () => 'massing-grow';

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    this.groups.buildings.add(mesh);
    this.buildingMesh = mesh;

    // Контурные рёбра: без них массинг на общем плане слипается
    // в однородное серое поле. На больших участках пропускаем —
    // построение рёбер стоит дороже, чем сама застройка.
    if (geo.attributes.position.count < 400000) {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo, 42),
        new THREE.LineBasicMaterial({ color: 0x6f6a63, transparent: true, opacity: 0.22 })
      );
      edges.name = 'edges';
      this.groups.buildings.add(edges);
    }
    this.needsRender = true;
  }

  /**
   * Точка на поверхности земли под курсором.
   *
   * Луч пускается только по верху керна: если ловить попадания по
   * всей сцене, вершина линии садилась бы на крышу здания или на
   * крону дерева, а размечают по земле.
   */
  groundPoint(clientX, clientY) {
    if (!this.coreTop) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.coreTop, false)[0];
    return hit ? [hit.point.x, hit.point.y, hit.point.z] : null;
  }

  /**
   * Карта инсоляции: сетка над землёй, раскрашенная по часам солнца.
   *
   * Кладём вершинным цветом, а не текстурой: сетка и так с шагом в
   * шесть метров, интерполяция между её узлами даёт ровно ту мягкость,
   * которая нужна, а текстуру пришлось бы ещё натягивать на рельеф.
   * Материал без освещения — иначе тень от домов ложилась бы поверх
   * карты теней и читалась бы дважды.
   */
  setInsolation(map) {
    const g = this.groups.insol;
    for (const m of [...g.children]) { m.geometry.dispose(); m.material.dispose(); g.remove(m); }
    if (!map) { this.needsRender = true; return; }

    const { data, n, origin, step } = map;
    const peak = Math.max(1, map.maxHours || 8);
    const pos = [], col = [];
    const at = (i, j) => {
      const x = origin + i * step, z = origin + j * step;
      const y = (this.terrain ? terrainAt(this.terrain, x, z) : 0) + 0.5;
      return [x, y, z];
    };
    /* Шкала намеренно не радужная: от глубокой тени к светлому солнцу
       одним ходом. Радуга красива, но по ней невозможно сказать, где
       больше, не сверяясь с легендой на каждый цвет.

       Верх шкалы — максимум этого дня, а не постоянные восемь часов:
       под Москвой в июне светло семнадцать часов, и на постоянной
       шкале весь двор упирался в потолок и выходил ровно белым.

       Недобор норматива красится терракотой. Это единственное место
       в сцене, где цвет несёт смысл, и здесь он его несёт: два часа —
       граница, ниже которой участок считается непригодным, и её надо
       видеть, не сверяясь со шкалой. */
    const tone = (h) => {
      if (h < 2) {
        const k = Math.max(0, Math.min(1, h / 2));
        return [0.45 + 0.25 * k, 0.16 + 0.10 * k, 0.10 + 0.06 * k];
      }
      const k = Math.max(0, Math.min(1, (h - 2) / Math.max(0.5, peak - 2)));
      return [0.42 + 0.52 * k, 0.36 + 0.50 * k, 0.30 + 0.42 * k];
    };

    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const v = [data[j * n + i], data[j * n + i + 1],
                   data[(j + 1) * n + i + 1], data[(j + 1) * n + i]];
        if (v.some(h => h < 0)) continue;         // под домом и вне круга не красим
        const p = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
        const c = v.map(tone);
        const push = (a, b, d) => {
          pos.push(...p[a], ...p[b], ...p[d]);
          col.push(...c[a], ...c[b], ...c[d]);
        };
        push(0, 1, 2); push(0, 2, 3);
      }
    }
    if (!pos.length) { this.needsRender = true; return; }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.88, depthWrite: false
    }));
    mesh.renderOrder = 5;
    g.add(mesh);
    this.needsRender = true;
  }

  /** Заменяет всю разметку набором готовых мешей. */
  setAnnotations(meshes) {
    const g = this.groups.annot;
    for (const m of [...g.children]) { m.geometry.dispose(); m.material.dispose(); g.remove(m); }
    for (const m of meshes) g.add(m);
    this.needsRender = true;
  }

  /**
   * Помеченные здания: один меш из кусков общей геометрии застройки.
   *
   * Копировать вершины дешевле, чем держать отдельный материал на
   * каждое здание: помеченных бывает несколько десятков, а вызовов
   * отрисовки при этом остаётся один.
   */
  setMarked(ranges) {
    const g = this.groups.marks;
    for (const m of [...g.children]) { m.geometry.dispose(); g.remove(m); }
    if (!ranges.length || !this.buildingMesh) { this.needsRender = true; return; }

    const src = this.buildingMesh.geometry.attributes.position.array;
    let n = 0;
    for (const r of ranges) n += (r.end - r.start) * 9;
    const pos = new Float32Array(n);
    let o = 0;
    for (const r of ranges) {
      const part = src.subarray(r.start * 9, r.end * 9);
      pos.set(part, o); o += part.length;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0xb4472c, roughness: 0.9, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    }));
    mesh.castShadow = true;
    g.add(mesh);
    this.needsRender = true;
  }

  /** Проигрывает подъём застройки: волна от центра участка к краю. */
  playGrowth(ms = 1400) {
    if (!this.grow) return;
    this.growth = { t0: performance.now(), ms };
    this.grow.value = 0;
    // Рёбра строятся из EdgesGeometry и не знают про рост: во время
    // анимации они висели бы каркасом на конечной высоте.
    const e = this.groups.buildings.getObjectByName('edges');
    if (e) e.visible = false;
    // Пока объёмы растут, карту теней приходится обновлять каждый кадр —
    // иначе тени остаются от конечной высоты и висят под пустотой.
    this.renderer.shadowMap.autoUpdate = true;
    this.needsRender = true;
  }

  setSurface(kind, positions) {
    if (!positions || !positions.length) return;
    // Строго нейтральная шкала: слои различаются только светлотой.
    // Цветные вода и зелень тянули на себя внимание и спорили с
    // застройкой — в макете важна морфология, а не раскраска.
    const conf = {
      green: [0xb4b2ab, 'green'],
      // Двор различается тоном покрытия: асфальт парковки темнее
      // газона и светлее проезжей части, площадка — светлее обеих.
      paved: [0xa6a49e, 'paved'],
      water: [0x9a9894, 'water'],
      roadsMain: [0x9e9b95, 'roads'],
      roadsSoft: [0xaeaba4, 'roads'],
      fences: [0xa8a6a0, 'fences'],
      bridges: [0xa4a29c, 'roads']
    }[kind];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    // В монохроме вода отличается не цветом, а поведением поверхности:
    // гладкая, она ловит отражение неба и читается как вода даже в
    // строго серой шкале.
    const wet = kind === 'water';
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: conf[0], roughness: wet ? 0.16 : 1.0, metalness: wet ? 0.35 : 0
    }));
    mesh.receiveShadow = true;
    if (kind === 'bridges') mesh.castShadow = true;
    this.groups[conf[1]].add(mesh);
    this.needsRender = true;
  }

  /* ---------- население сцены ---------- */

  /**
   * Деревья, транспорт и мачты — инстансингом: одна геометрия, одна
   * матрица на объект, один вызов отрисовки на тип. Формы намеренно
   * грубые: на масштабе квартала важен силуэт и объём, а не крона.
   */
  setProps(kind, data) {
    if (!data || !data.length) return;
    const n = data.length / 5;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    const make = (geo, mat, fit) => {
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      // Тени оставляем только деревьям: у машин и мачт они на масштабе
      // квартала неразличимы, а карту теней тысячи мелких объектов
      // удваивают в цене.
      mesh.castShadow = kind === 'trees';
      mesh.receiveShadow = kind === 'trees';
      for (let i = 0; i < n; i++) {
        const x = data[i * 5], y = data[i * 5 + 1], z = data[i * 5 + 2];
        const size = data[i * 5 + 3], rot = data[i * 5 + 4];
        fit(pos, scl, x, y, z, size);
        q.setFromAxisAngle(up, rot);
        mesh.setMatrixAt(i, m.compose(pos, q, scl));
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;         // общий бокс покрывает весь керн
      this.groups[kind].add(mesh);
    };

    if (kind === 'trees') {
      // Крона — низкополигональный шар: двадцать граней дают мягкий
      // силуэт и не съедают кадр даже на нескольких тысячах деревьев.
      const crown = new THREE.IcosahedronGeometry(1, 0);
      crown.translate(0, 1.15, 0);
      make(crown, new THREE.MeshStandardMaterial({ color: 0x9a9791, roughness: 1, flatShading: true }),
        (p, s, x, y, z, h) => {
          p.set(x, y, z);
          const r = h * 0.34;
          s.set(r, h * 0.42, r);
        });

      const trunk = new THREE.CylinderGeometry(0.16, 0.22, 1, 5);
      trunk.translate(0, 0.5, 0);
      make(trunk, new THREE.MeshStandardMaterial({ color: 0x7a7770, roughness: 1 }),
        (p, s, x, y, z, h) => { p.set(x, y, z); s.set(1, h * 0.55, 1); });

    } else if (kind === 'cars') {
      const body = new THREE.BoxGeometry(1.85, 1.05, 4.4);
      body.translate(0, 0.62, 0);
      const roof = new THREE.BoxGeometry(1.65, 0.62, 2.3);
      roof.translate(0, 1.45, -0.2);
      const car = mergeShapes([body, roof]);
      make(car, new THREE.MeshStandardMaterial({ color: 0xa8a6a1, roughness: 0.5, metalness: 0.15 }),
        (p, s, x, y, z, k) => { p.set(x, y, z); s.set(k, k, k); });

    } else if (kind === 'lamps') {
      const post = new THREE.CylinderGeometry(0.09, 0.13, 1, 5);
      post.translate(0, 0.5, 0);
      const head = new THREE.BoxGeometry(0.9, 0.16, 0.28);
      head.translate(0.35, 1.0, 0);
      const lamp = mergeShapes([post, head]);
      make(lamp, new THREE.MeshStandardMaterial({ color: 0x8b8984, roughness: 0.8 }),
        (p, s, x, y, z, h) => { p.set(x, y, z); s.set(1, h, 1); });
    }
    this.renderer.shadowMap.needsUpdate = true;
    this.needsRender = true;
  }

  /* ---------- проектные объёмы ---------- */

  // Полигоны приходят в локальных метрах — от ИИ или из GeoJSON.
  addProposal(items) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xb4472c, roughness: 0.8, metalness: 0 });
    const added = [];
    for (const it of items) {
      if (!it.polygon || it.polygon.length < 3) continue;
      const shape = new THREE.Shape(it.polygon.map(p => new THREE.Vector2(p[0], -p[1])));
      const h = Math.max(3, +it.height || (+it.levels || 5) * 3);

      // Как и существующая застройка, новый объём садится на рельеф:
      // низ опускаем до самой низкой точки контура.
      let ground = 0, lowest = 0;
      if (this.terrain) {
        let sx = 0, sz = 0;
        for (const [x, z] of it.polygon) { sx += x; sz += z; }
        ground = terrainAt(this.terrain, sx / it.polygon.length, sz / it.polygon.length);
        lowest = ground;
        for (const [x, z] of it.polygon) lowest = Math.min(lowest, terrainAt(this.terrain, x, z));
        lowest -= 1.5;
      }
      const depth = Math.max(ground + h - lowest, 3);

      let g;
      try { g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 }); }
      catch { continue; }
      g.translate(0, 0, ground + h - depth);
      g.rotateX(-Math.PI / 2);
      g.deleteAttribute('uv');
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData = it;
      this.groups.proposal.add(mesh);
      added.push(it);
    }
    this.proposal = (this.proposal || []).concat(added);
    this.renderer.shadowMap.needsUpdate = true;
    this.needsRender = true;
    return added.length;
  }

  clearProposal() {
    this.groups.proposal.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    this.groups.proposal.clear();
    this.proposal = [];
    this.renderer.shadowMap.needsUpdate = true;
    this.needsRender = true;
  }

  /* ---------- солнце ---------- */

  setSun(altitude, azimuth) {
    const v = sunVector(altitude, azimuth);
    const d = this.extent * 1.8;
    this.sun.position.set(v.x * d, Math.max(v.y, 0.02) * d, v.z * d);
    this.sun.target.position.set(0, 0, 0);
    this.sun.target.updateMatrixWorld();

    const s = this.sun.shadow.camera;
    // Рамка теней по участку с небольшим запасом на высоту домов.
    // Раньше она была вдвое шире круга, и половина карты уходила в
    // пустоту — при том же разрешении тень была вдвое грубее.
    const r = this.extent * 0.6 + 60;
    s.left = -r; s.right = r; s.top = r; s.bottom = -r;
    s.near = 1; s.far = d * 3.5;
    s.updateProjectionMatrix();

    // Контровой — с противоположной стороны и чуть выше горизонта.
    this.rim.position.set(-v.x * d, Math.max(0.35, v.y * 0.6) * d, -v.z * d);

    const a = Math.sin(Math.max(altitude, 0));
    this.sun.intensity = altitude <= 0 ? 0 : 0.5 + 2.0 * a;
    this.sun.visible = altitude > 0;
    // У горизонта свет теплее и слабее — как в реальные утро и вечер.
    const warm = 1 - Math.min(a * 2.2, 1);
    this.sun.color.setRGB(1, 1 - warm * 0.13, 1 - warm * 0.30);
    // Заполняющий свет неба держит теневые фасады читаемыми:
    // без него северные стены проваливаются в чёрное.
    this.hemi.intensity = altitude > 0 ? 0.55 : 0.75;
    this.scene.environmentIntensity = altitude > 0 ? 0.75 : 0.45;

    this.renderer.shadowMap.needsUpdate = true;
    this.needsRender = true;
  }

  /* ---------- камера ---------- */

  setCameraMode(mode) {
    const pos = this.camera.position.clone();
    const target = this.controls.target.clone();
    this.camera = mode === 'ortho' ? this.ortho : this.persp;
    this.camera.position.copy(pos);
    this.controls.object = this.camera;
    this.controls.target.copy(target);
    this.renderPass.camera = this.camera;
    this.gtao.camera = this.camera;
    this.resize();
    this.controls.update();
    this.renderer.shadowMap.needsUpdate = true;
    this.needsRender = true;
  }

  /**
   * Расстояние, с которого керн целиком попадает в кадр.
   * Панель управления закрывает правую четверть окна, поэтому в расчёт
   * идёт не вся ширина, а свободная — иначе на ноутбуке модель упиралась
   * в панель и обрезалась.
   */
  fitDistance(span) {
    const w = this.container.clientWidth || 1200;
    const h = this.container.clientHeight || 800;
    const panel = document.querySelector('.controls');
    const busy = panel && !panel.classList.contains('collapsed')
      ? Math.min(panel.getBoundingClientRect().width + 40, w * 0.45) : 0;
    const usable = Math.max(w - busy, w * 0.5);

    const halfFov = (this.persp.fov / 2) * Math.PI / 180;
    const byHeight = span / (2 * Math.tan(halfFov));
    const byWidth = span / (2 * Math.tan(halfFov) * (usable / h));
    return Math.max(byHeight, byWidth);
  }

  setView(kind, ms = 700) {
    const e = this.extent;
    const top = this.terrain ? this.terrain.max : 0;
    const p = new THREE.Vector3();
    // Керн — конечный объект, и в кадр он должен попадать целиком
    // вместе с толщей, поэтому камера стоит дальше, чем нужно было
    // бесконечной плоскости.
    // Диаметр керна плюс запас на толщу и поля кадра.
    const span = e * 1.18;

    if (kind === 'top') {
      p.set(0.001, this.fitDistance(span) + top, 0.001);
    } else if (kind === 'eye') {
      // Уровень глаз пешехода — 1.7 м над землёй в этой точке.
      const x = e * 0.38, z = e * 0.38;
      p.set(x, terrainAt(this.terrain, x, z) + 1.7, z);
    } else {
      // Изометрия: направление 45° по плану, наклон около 38° к горизонту.
      const d = this.fitDistance(span);
      const k = d / Math.sqrt(0.62 * 0.62 * 2 + 0.5 * 0.5);
      p.set(0.62 * k, 0.5 * k + top, 0.62 * k);
    }
    // Взгляд держим горизонтальным: OrbitControls не пускает камеру
    // выше зенитного предела, а значит и смотреть вверх не даёт.
    const t = new THREE.Vector3(0, kind === 'eye' ? terrainAt(this.terrain, 0, 0) + 1.7 : 0, 0);
    this.moveCamera(p, t, ms);
  }

  // Смена ракурса перелётом, а не рывком: пользователь не теряет
  // ориентацию в модели.
  moveCamera(pos, target, ms = 700) {
    if (ms <= 0) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.needsRender = true;
      return;
    }
    this.tween = {
      t0: performance.now(), ms,
      fromP: this.camera.position.clone(), toP: pos.clone(),
      fromT: this.controls.target.clone(), toT: target.clone()
    };
    this.setQuality(false);
    this.needsRender = true;
  }

  /* ---------- выбор здания ---------- */

  pick(clientX, clientY) {
    // Во время подъёма застройки вершины сдвигает шейдер, а луч летит
    // по исходным координатам — попадания были бы неверными.
    if (!this.buildingMesh || this.growth) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.buildingMesh, false)[0];
    if (!hit) return null;

    // merged-геометрия без индексов: номер треугольника → диапазон здания
    const f = hit.faceIndex;
    let lo = 0, hi = this.index.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, e = this.index[mid];
      if (f < e.start) hi = mid - 1;
      else if (f >= e.end) lo = mid + 1;
      else return { ...e.b, _range: e };
    }
    return null;
  }

  /** Мягкая подсветка объёма под курсором — до того, как по нему кликнули. */
  setHover(range) {
    if (this._hoverKey === (range ? range.start : -1)) return;
    this._hoverKey = range ? range.start : -1;

    if (this.hoverMesh) {
      this.hoverMesh.geometry.dispose();
      this.groups.highlight.remove(this.hoverMesh);
      this.hoverMesh = null;
    }
    if (range && this.buildingMesh) {
      const src = this.buildingMesh.geometry.attributes.position.array;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position',
        new THREE.BufferAttribute(src.slice(range.start * 9, range.end * 9), 3));
      geo.computeVertexNormals();
      this.hoverMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xb4472c, transparent: true, opacity: 0.22, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
      }));
      this.groups.highlight.add(this.hoverMesh);
    }
    this.needsRender = true;
  }

  // Подсветка не пересобирает геометрию: вырезаем диапазон вершин
  // из уже построенного меша.
  // Выбранное здание живёт отдельным мешем от подсветки под курсором,
  // иначе одно стирало бы другое.
  highlight(range) {
    if (this.pickMesh) {
      this.pickMesh.geometry.dispose();
      this.groups.highlight.remove(this.pickMesh);
      this.pickMesh = null;
    }
    if (!range || !this.buildingMesh) { this.needsRender = true; return; }

    const src = this.buildingMesh.geometry.attributes.position.array;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',
      new THREE.BufferAttribute(src.slice(range.start * 9, range.end * 9), 3));
    geo.computeVertexNormals();
    this.pickMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0xb4472c, roughness: 0.85, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    }));
    this.groups.highlight.add(this.pickMesh);
    this.needsRender = true;
  }

  /* ---------- слои ---------- */

  toggle(name, on) {
    if (name === 'shadow') {
      this.renderer.shadowMap.enabled = on;
      this.renderer.shadowMap.needsUpdate = true;
      this.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
    } else if (name === 'ao') {
      this.aoOn = on;
      this.gtao.enabled = on && this._hi;
    } else if (name === 'tilt') {
      this.tiltOn = on;
      this.tilt.enabled = on && this._hi;
    } else if (name === 'orbit') {
      this.orbit = on;
      this.needsRender = true;
    } else if (name === 'edges') {
      const e = this.groups.buildings.getObjectByName('edges');
      if (e) e.visible = on;
    } else if (this.groups[name]) {
      this.groups[name].visible = on;
    }
    this.needsRender = true;
  }

  setEstimatedVisible(on) {
    const mesh = this.buildingMesh;
    if (!mesh) return;
    const col = mesh.geometry.attributes.color;
    if (!this._baseColors) this._baseColors = col.array.slice();
    if (on) {
      for (const e of this.index) {
        if (!e.b.estimated) continue;
        for (let i = e.start * 9; i < e.end * 9; i += 3) {
          col.array[i] = 0.78; col.array[i + 1] = 0.55; col.array[i + 2] = 0.42;
        }
      }
    } else {
      col.array.set(this._baseColors);
    }
    col.needsUpdate = true;
    this.needsRender = true;
  }

  /* ---------- цикл ---------- */

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.tilt.uniforms.resolution.value = [w * pr, h * pr];

    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const half = this.extent * 0.62, ar = w / h;
    this.ortho.left = -half * ar; this.ortho.right = half * ar;
    this.ortho.top = half; this.ortho.bottom = -half;
    this.ortho.updateProjectionMatrix();
    this.needsRender = true;
  }

  /**
   * Рисует кадр немедленно, не дожидаясь requestAnimationFrame.
   * Браузер не выдаёт кадры, когда вкладка в фоне, свёрнута или лежит
   * на другом рабочем столе, — и тогда собранная сцена оставалась
   * невидимой под заслонкой. Здесь же кадр гарантированно уходит
   * в буфер, а на экране появляется, как только вкладку показывают.
   */
  renderNow() {
    if (!this.container.clientWidth) return;
    this.controls.update();
    this.updateFog();
    this.composer.render();
    this.rendered = true;
    this.needsRender = false;
    this.onFrame?.();
  }

  animate = () => {
    requestAnimationFrame(this.animate);

    if (this.growth) {
      const k = Math.min(1, (performance.now() - this.growth.t0) / this.growth.ms);
      this.grow.value = k;
      this.needsRender = true;
      if (k >= 1) {
        this.growth = null;
        this.renderer.shadowMap.autoUpdate = false;
        this.renderer.shadowMap.needsUpdate = true;
        const e = this.groups.buildings.getObjectByName('edges');
        if (e) e.visible = this.edgesOn !== false;
      }
    }

    if (this.orbit && !this.tween) {
      // Медленный облёт в покое: модель «дышит», как на витрине.
      const a = this.orbitSpeed * 0.0016;
      const p = this.camera.position, t = this.controls.target;
      const dx = p.x - t.x, dz = p.z - t.z;
      p.x = t.x + dx * Math.cos(a) - dz * Math.sin(a);
      p.z = t.z + dx * Math.sin(a) + dz * Math.cos(a);
      this.needsRender = true;
    }

    if (this.tween) {
      const k = Math.min(1, (performance.now() - this.tween.t0) / this.tween.ms);
      const e = easeInOut(k);
      this.camera.position.lerpVectors(this.tween.fromP, this.tween.toP, e);
      this.controls.target.lerpVectors(this.tween.fromT, this.tween.toT, e);
      this.controls.update();
      this.needsRender = true;
      if (k >= 1) { this.tween = null; this.setQuality(true); }
    }

    const moved = this.controls.update();
    if (moved || this.needsRender) {
      const t0 = performance.now();
      this.needsRender = false;
      this.updateFog();
      this.composer.render();
      this.rendered = true;
      // Замер по времени кадра, а не по счётчику: сцена рисуется
      // только при изменениях, и обычный счётчик кадров в секунду
      // показывал бы простой, а не стоимость отрисовки.
      const dt = performance.now() - t0;
      this.frameMs = this.frameMs ? this.frameMs * 0.9 + dt * 0.1 : dt;
      this.fps = Math.round(1000 / Math.max(this.frameMs, 0.1));
      this.autoQuality();
      this.onFrame?.();
    }
  };

  // Дымка привязана к текущему удалению камеры, а не к размеру
  // участка: иначе она либо не скрывает край земли на общем плане,
  // либо съедает всю модель при взгляде сверху.
  /**
   * Страховка на слабой машине: если кадр стабильно дороже 22 мс,
   * снижаем разрешение, а на совсем тяжёлых — гасим затенение.
   * Порог с запасом: цель — держаться выше 45 кадров в секунду.
   */
  autoQuality() {
    if (!this._hi || this.growth) return;
    this._slow = this.frameMs > 22 ? (this._slow || 0) + 1 : 0;
    if (this._slow < 20 || this._degraded === 2) return;

    this._degraded = (this._degraded || 0) + 1;
    this._slow = 0;
    if (this._degraded === 1) {
      this.maxPR = Math.max(1, this.maxPR * 0.7);
      this.renderer.setPixelRatio(this.maxPR);
      this.composer.setPixelRatio(this.maxPR);
      this.onDegrade?.('Разрешение снижено: кадр не укладывался в бюджет.');
    } else {
      this.aoOn = false;
      this.gtao.enabled = false;
      this.onDegrade?.('Объёмное затенение выключено ради плавности.');
    }
    this.needsRender = true;
  }

  updateFog() {
    if (!this.scene.fog) return;
    const d = this.camera.position.distanceTo(this.controls.target);
    this.scene.fog.near = Math.max(d * 0.9, this.extent * 0.35);
    this.scene.fog.far = Math.max(d * 3.0, this.extent * 1.6);
  }

  /** Кадр в PNG с повышенным разрешением. */
  exportPNG(scale = 2) {
    const pr = this.renderer.getPixelRatio();
    const hi = this._hi;
    this.setQuality(true);
    this.renderer.setPixelRatio(scale);
    this.composer.setPixelRatio(scale);
    this.composer.render();
    const url = this.renderer.domElement.toDataURL('image/png');
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this._hi = hi;
    this.needsRender = true;
    return url;
  }

  /** Текущий кадр как base64 без префикса — для отправки в модель. */
  frameBase64(maxSide = 1280) {
    const url = this.exportPNG(1);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png').split(',')[1]);
      };
      img.src = url;
    });
  }

  /* ============================================================
     Выгрузка модели

     Прежде наружу уходила только застройка и только треугольниками:
     один безымянный объект, без рельефа, дорог и зелени. Открыть его
     было можно, работать с ним — нет: в Blender приезжала слипшаяся
     масса, в которой ни выбрать дом, ни отделить землю.

     Теперь собирается отдельная сцена выгрузки — те же геометрии,
     но разложенные по именованным слоям и с обычными материалами
     вместо экранных. Слои называются латиницей: это имена объектов
     в чужой программе, и кириллица в них живёт плохо.
     ============================================================ */

  /**
   * Сцена для выгрузки: слои, материалы, привязка к местности.
   *
   * Инстансы деревьев и машин здесь запекаются в обычную геометрию.
   * glTF умеет хранить их расстановкой (EXT_mesh_gpu_instancing), но
   * это расширение читают далеко не все, и дерево, которое не поняли,
   * выгружается в одном экземпляре в начале координат. Запечённая
   * геометрия тяжелее, зато открывается везде одинаково.
   */
  exportScene(site = null) {
    const root = new THREE.Group();
    root.name = 'MASSING';
    // Локальные метры сами по себе ничего не значат: без привязки
    // модель невозможно поставить на место. Кладём её в extras —
    // glTF переносит userData в них дословно.
    root.userData = {
      generator: 'МАССИНГ',
      units: 'meters',
      axes: 'X — восток, Z — юг, Y — вверх (правая система glTF)',
      origin: site ? { lat: site.lat0, lon: site.lon0, radius: site.radius } : null,
      attribution: '© OpenStreetMap contributors (ODbL)'
    };

    const bakeInstanced = (im) => {
      const g = im.geometry;
      const pos = g.attributes.position, nor = g.attributes.normal;
      const idx = g.index;
      const count = idx ? idx.count : pos.count;
      const out = new Float32Array(count * 3 * im.count);
      const outN = new Float32Array(count * 3 * im.count);
      const m = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3();
      let k = 0;
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m);
        nm.getNormalMatrix(m);
        for (let t = 0; t < count; t++) {
          const j = idx ? idx.getX(t) : t;
          v.fromBufferAttribute(pos, j).applyMatrix4(m);
          out[k] = v.x; out[k + 1] = v.y; out[k + 2] = v.z;
          v.fromBufferAttribute(nor, j).applyMatrix3(nm).normalize();
          outN[k] = v.x; outN[k + 1] = v.y; outN[k + 2] = v.z;
          k += 3;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(outN, 3));
      return geo;
    };

    // Экранный материал завязан на врезки в шейдер и на зерно по
    // мировым координатам — в чужой программе от него ничего не
    // остаётся. Отдаём равноценный обычный.
    const plainMat = (src) => new THREE.MeshStandardMaterial({
      color: src.color ? src.color.clone() : 0xffffff,
      roughness: src.roughness ?? 1,
      metalness: src.metalness ?? 0,
      vertexColors: !!src.vertexColors,
      flatShading: !!src.flatShading,
      side: src.side
    });

    // Ключ группы в сцене → имя слоя в файле.
    const LAYERS = [
      ['buildings', 'buildings'], ['proposal', 'proposal_volumes'],
      ['ground', 'terrain'], ['roads', 'roads'], ['paved', 'paved'],
      ['green', 'green'], ['water', 'water'], ['trees', 'trees'],
      ['fences', 'fences'], ['cars', 'cars'], ['lamps', 'lamps']
    ];

    for (const [key, name] of LAYERS) {
      const src = this.groups[key];
      if (!src || !src.children.length) continue;
      const layer = new THREE.Group();
      layer.name = name;
      for (const o of src.children) {
        // Контурные рёбра — приём экранной подачи, а не геометрия.
        if (!o.geometry || o.name === 'edges' || o.isLineSegments) continue;
        const geo = o.isInstancedMesh ? bakeInstanced(o) : o.geometry;
        const mesh = new THREE.Mesh(geo, plainMat(o.material));
        mesh.name = name + (layer.children.length ? `_${layer.children.length}` : '');
        layer.add(mesh);
      }
      if (layer.children.length) root.add(layer);
    }
    return root;
  }

  /** Модель целиком в GLB — открывается в Blender, Rhino, Unreal. */
  exportGLB(site = null) {
    const scene = this.exportScene(site);
    return new Promise((resolve, reject) => {
      new GLTFExporter().parse(
        scene,
        (buf) => resolve(buf),
        (err) => reject(err),
        { binary: true, onlyVisible: false }
      );
    });
  }

  /** То же в OBJ — для программ, которые не читают glTF. */
  exportOBJ(site = null) {
    return new OBJExporter().parse(this.exportScene(site));
  }
}
