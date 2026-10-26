// ==========================================================
// Bloom Coffee Co. — interactive 3D coffee scene (Three.js)
//
// What is real 3D here: every object is built from procedural
// geometry and rendered by WebGL in your browser — nothing is an image.
// ==========================================================
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;

// ---- Scene layout constants (all in "stage" units) ----
const CARAFE_TILT = 1.7;               // radians: how far the carafe is tipped over
const CARAFE_POS = [2.533, 1.72, 0];   // position of the carafe base
const CUP_Y = -2.02;                   // y of the cup's foot
const SURFACE_Y = CUP_Y + 1.0;         // y of the coffee surface inside the cup
const STREAM_TOP = { x: 0.5, y: 1.22 };// where the stream leaves the carafe lip
const STREAM_END_X = 0.0;              // where it lands (cup centre)
const LIQUID_LEVEL = 1.28;             // world-space height of coffee inside the carafe

// Small deterministic random generator so the layout is the same every load
function seededRandom(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn [radius, height] pairs into a smooth profile for LatheGeometry (spins around Y). */
function smoothProfile(pairs, divisions) {
  const curve = new THREE.CatmullRomCurve3(pairs.map(([r, y]) => new THREE.Vector3(r, y, 0)), false, 'centripetal');
  return curve.getPoints(divisions).map((p) => new THREE.Vector2(Math.max(p.x, 0), p.y));
}

/** Soft round gradient texture, used for the contact shadow and steam puffs. */
function radialTexture(rgb, alpha) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Procedural coffee bean: a squashed sphere with a curved crease pressed into one side. */
function createBeanGeometry() {
  let geo = new THREE.SphereGeometry(1, 40, 28);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    let z = pos.getZ(i);
    if (z > 0) {
      const d = y - 0.14 * Math.sin(x * 3.2);                  // wavy centre line
      const groove = Math.exp(-d * d * 40) * (1 - x * x);      // 1 on the line, 0 away from it
      z *= 0.85 * (1 - 0.7 * groove);                          // flatten + press the groove in
    }
    pos.setXYZ(i, x * 0.5, y * 0.33, z * 0.26);               // bean proportions
  }
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo);      // weld seam vertices so shading has no visible seam
  geo.computeVertexNormals();
  return geo;
}

// ----------------------------------------------------------
// Custom shader: the pouring stream
// The stream is a thin tube whose vertices are bent and
// pulsed in the vertex shader every frame, so it looks like
// flowing liquid instead of a rigid cylinder.
// ----------------------------------------------------------
const STREAM_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uTopX;
  uniform float uBotX;
  uniform float uTopY;
  uniform float uBotY;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vT;

  void main() {
    // t = 0 at the carafe lip, 1 where the coffee hits the cup
    float t = clamp(0.5 - position.y, 0.0, 1.0);
    vec2 dir = normalize(position.xz);          // outward direction of this vertex

    // Travelling bulges make the stream thicken and thin as it flows
    float waveA = sin(t * 24.0 - uTime * 9.0);
    float waveB = sin(t * 9.0 - uTime * 5.0 + 1.7);
    float radius = mix(0.145, 0.082, t);        // stream thins as it falls
    radius *= 1.0 + 0.14 * waveA + 0.07 * waveB;
    radius *= mix(0.85, 1.0, smoothstep(0.0, 0.1, t));
    radius += 0.07 * smoothstep(0.9, 1.0, t);   // flares out where it meets the surface

    // sqrt(t) makes a natural parabola: leaves the lip sideways, then falls
    float cx = mix(uTopX, uBotX, sqrt(t));
    cx += 0.025 * sin(t * 10.0 - uTime * 3.5) * sin(t * 3.14159);   // gentle sway
    float cz = 0.02 * sin(t * 8.0 - uTime * 2.7 + 2.0) * sin(t * 3.14159);

    vec3 p = vec3(cx + dir.x * radius, mix(uTopY, uBotY, t), cz + dir.y * radius);

    vNormal = normalize(normalMatrix * vec3(dir.x, 0.0, dir.y));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vView = -mv.xyz;
    vT = t;
    gl_Position = projectionMatrix * mv;
  }
`;

const STREAM_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vT;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vView);
    vec3 L = normalize(vec3(-0.5, 0.8, 0.6));
    vec3 H = normalize(L + V);

    float facing = max(dot(N, V), 0.0);
    float fresnel = pow(1.0 - facing, 3.0);
    float spec = pow(max(dot(N, H), 0.0), 80.0);
    float spec2 = pow(max(dot(N, normalize(vec3(0.7, 0.3, 0.6) + V)), 0.0), 40.0);

    // Light caramel glows through the centre, deep espresso at the edges
    vec3 deep = vec3(0.07, 0.028, 0.012);
    vec3 caramel = vec3(0.50, 0.23, 0.07);
    vec3 col = mix(deep, caramel, pow(facing, 1.6) * 0.8);

    // Moving streaks give a sense of flow
    float streak = 0.5 + 0.5 * sin(vT * 46.0 - uTime * 11.0);
    col *= 0.9 + 0.2 * streak;

    col += fresnel * vec3(0.45, 0.28, 0.14) * 0.5;
    col += spec * vec3(1.0, 0.92, 0.8) * 1.2 + spec2 * vec3(1.0, 0.75, 0.5) * 0.25;

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ----------------------------------------------------------
// Custom shader: the coffee surface in the cup
// Ripples spread out from the impact point; a crema ring
// of caramel foam sits near the edge.
// ----------------------------------------------------------
const SURFACE_VERT = /* glsl */ `
  varying vec2 vP;
  varying vec3 vViewPos;
  varying vec3 vNn;
  varying vec3 vTan;
  varying vec3 vBit;
  void main() {
    vP = position.xy / 0.9;                       // -1..1 across the disc
    vNn = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
    vTan = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));
    vBit = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const SURFACE_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vP;
  varying vec3 vViewPos;
  varying vec3 vNn;
  varying vec3 vTan;
  varying vec3 vBit;

  void main() {
    float r = length(vP);
    vec2 dir = r > 0.001 ? vP / r : vec2(0.0);

    // Slope of two ripple waves (derivative of the height) -> bends the surface normal
    float phase = r * 34.0 - uTime * 5.5;
    float slope = exp(-r * 2.4) * (34.0 * cos(phase) - 2.4 * sin(phase)) * 0.0042;
    slope += exp(-r * 1.2) * 14.0 * cos(r * 14.0 + uTime * 1.7) * 0.0012;
    vec2 g = dir * slope;
    vec3 N = normalize(vTan * -g.x + vBit * -g.y + vNn);

    vec3 V = normalize(vViewPos);
    vec3 L = normalize(vec3(-0.4, 0.75, 0.55));
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 140.0);
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 4.0);

    float rim = smoothstep(0.55, 0.98, r);
    float swirl = 0.5 + 0.5 * sin(atan(vP.y, vP.x) * 3.0 + r * 9.0 - uTime * 0.6);
    vec3 deep = vec3(0.05, 0.022, 0.012);
    vec3 crema = vec3(0.50, 0.26, 0.09);
    vec3 col = mix(deep, crema, rim * 0.75 + 0.15 * swirl * rim);

    col += vec3(0.35, 0.17, 0.05) * exp(-r * 7.0) * (0.5 + 0.5 * sin(uTime * 9.0)); // impact glow
    col += fresnel * vec3(0.55, 0.4, 0.28) * 0.35 + spec * vec3(1.0, 0.92, 0.8);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ==========================================================
// Main entry point
// ==========================================================
export function initCoffeeScene({ container, reducedMotion = false }) {
  if (!container) return null;

  // ---------- Renderer (with graceful failure if WebGL is unavailable) ----------
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (error) {
    container.classList.add('scene--fallback');
    return null;
  }

  const smallScreen = window.matchMedia('(max-width: 768px)').matches;
  const maxPixelRatio = smallScreen ? 1.5 : 2; // cap pixel ratio: big performance win on phones
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.localClippingEnabled = true; // needed for the liquid level inside the carafe
  renderer.setClearColor(0x000000, 0);  // transparent: the page's cream background shows through

  const canvas = renderer.domElement;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Interactive 3D illustration of coffee pouring from a glass carafe into a cup. Drag to rotate.');
  container.prepend(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 60);

  // pivot = rotated by mouse/drag; stage = the actual objects, centred around the pivot
  const pivot = new THREE.Group();
  const stage = new THREE.Group();
  stage.position.set(-0.45, -0.35, 0);
  pivot.add(stage);
  scene.add(pivot);

  // ---------- Lighting ----------
  // RoomEnvironment is a built-in virtual studio: it gives glass and ceramic realistic reflections
  // without needing any image files.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;

  const keyLight = new THREE.DirectionalLight(0xffe2bd, 2.2); // warm main light
  keyLight.position.set(-4, 6, 6);
  const rimLight = new THREE.PointLight(0xff9a4d, 70, 22, 2); // orange back light for glowing edges
  rimLight.position.set(5, 2, -4);
  const fillLight = new THREE.HemisphereLight(0xfff1dc, 0x6b3a1c, 0.5);
  scene.add(keyLight, rimLight, fillLight);

  // ---------- Contact shadow under the saucer ----------
  const shadowTexture = radialTexture('43,24,16', 0.5);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(6.4, 6.4),
    new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0.2, CUP_Y - 0.1, 0);
  stage.add(shadow);

  // ---------- Cup + saucer (LatheGeometry: a 2D profile spun around the Y axis) ----------
  const ceramic = new THREE.MeshPhysicalMaterial({
    color: 0xf3e8d6, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08, side: THREE.DoubleSide,
  });
  const cupProfile = smoothProfile(
    [[0, 0], [0.5, 0], [0.58, 0.06], [0.74, 0.35], [0.92, 0.85], [1.04, 1.25], [1.03, 1.3], [0.98, 1.3],
     [0.96, 1.25], [0.84, 0.82], [0.64, 0.34], [0.5, 0.2], [0, 0.18]],
    90
  );
  const cup = new THREE.Mesh(new THREE.LatheGeometry(cupProfile, 72), ceramic);
  cup.position.y = CUP_Y;

  const cupHandle = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.07, 16, 36, Math.PI), ceramic);
  cupHandle.position.set(1.0, CUP_Y + 0.72, 0);
  cupHandle.rotation.z = -Math.PI / 2; // arc bulges to the right

  const saucerProfile = smoothProfile(
    [[0, 0.02], [0.9, 0], [1.5, 0.07], [1.75, 0.2], [1.7, 0.23], [1.45, 0.13], [0.7, 0.1], [0, 0.1]], 60
  );
  const saucer = new THREE.Mesh(new THREE.LatheGeometry(saucerProfile, 72), ceramic);
  saucer.position.y = CUP_Y - 0.1;
  stage.add(cup, cupHandle, saucer);

  // ---------- Coffee surface inside the cup (custom ripple shader) ----------
  const surfaceMaterial = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: SURFACE_VERT,
    fragmentShader: SURFACE_FRAG,
  });
  const surface = new THREE.Mesh(new THREE.CircleGeometry(0.9, 64), surfaceMaterial);
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = SURFACE_Y;
  stage.add(surface);

  // ---------- Glass carafe ----------
  const carafe = new THREE.Group();
  carafe.position.set(...CARAFE_POS);
  carafe.rotation.z = CARAFE_TILT;
  stage.add(carafe);

  const carafePairs = [[0, 0], [0.55, 0], [0.68, 0.04], [0.76, 0.35], [0.78, 0.7], [0.7, 1.15], [0.52, 1.5],
                       [0.36, 1.78], [0.31, 2.0], [0.34, 2.1], [0.37, 2.14]];
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.26,
    clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.7, side: THREE.DoubleSide, depthWrite: false,
  });
  const glass = new THREE.Mesh(new THREE.LatheGeometry(smoothProfile(carafePairs, 80), 64), glassMaterial);
  glass.renderOrder = 2; // draw glass after the coffee inside it

  // Coffee inside: same shape, slightly smaller. A world-space clipping plane keeps the
  // liquid surface flat (horizontal) even though the carafe is tilted — like real liquid.
  const liquidPairs = carafePairs.filter(([, y]) => y < 2.03).map(([r, y]) => [r * 0.92, y * 0.97 + 0.04]);
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), LIQUID_LEVEL); // keeps everything below y = constant
  const liquidMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x2a1208, emissive: 0x2a1004, emissiveIntensity: 0.6, roughness: 0.15,
    clearcoat: 1, clearcoatRoughness: 0.05, side: THREE.DoubleSide, clippingPlanes: [clipPlane],
  });
  const liquid = new THREE.Mesh(new THREE.LatheGeometry(smoothProfile(liquidPairs, 70), 56), liquidMaterial);

  // Dark handle + brass collar
  const handleMaterial = new THREE.MeshStandardMaterial({ color: 0x2a1810, roughness: 0.35, metalness: 0.2 });
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.05, 14, 40, Math.PI), handleMaterial);
  handle.position.set(0.6, 1.0, 0);
  handle.rotation.z = -Math.PI / 2;
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(0.335, 0.03, 12, 48),
    new THREE.MeshStandardMaterial({ color: 0xb98a4a, roughness: 0.3, metalness: 0.9 })
  );
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 1.98;
  carafe.add(liquid, glass, handle, collar);

  // ---------- Pouring stream (custom vertex-displaced tube) ----------
  const streamMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uTopX: { value: STREAM_TOP.x },
      uBotX: { value: STREAM_END_X },
      uTopY: { value: STREAM_TOP.y },
      uBotY: { value: SURFACE_Y - 0.04 },
    },
    vertexShader: STREAM_VERT,
    fragmentShader: STREAM_FRAG,
  });
  const stream = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 24, 80, true), streamMaterial);
  stream.frustumCulled = false; // vertices are moved by the shader, so the bounding box is wrong
  stage.add(stream);

  // ---------- Droplets (splash + floating) using InstancedMesh: many objects, one draw call ----------
  const random = seededRandom(7);
  const dummy = new THREE.Object3D();
  const dropGeometry = new THREE.SphereGeometry(1, 16, 12);
  const dropMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x4a2412, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.4,
  });

  const SPLASH_COUNT = smallScreen ? 12 : 18;
  const GRAVITY = 7.5;
  const splashMesh = new THREE.InstancedMesh(dropGeometry, dropMaterial, SPLASH_COUNT);
  splashMesh.frustumCulled = false;
  const splashData = Array.from({ length: SPLASH_COUNT }, () => {
    const lift = 1.6 + random() * 1.0;
    return { angle: random() * TAU, speed: 0.4 + random() * 0.7, lift, life: (2 * lift) / GRAVITY, offset: random() * 2, size: 0.025 + random() * 0.035 };
  });

  const FLOAT_COUNT = smallScreen ? 8 : 14;
  const floatMesh = new THREE.InstancedMesh(dropGeometry, dropMaterial, FLOAT_COUNT);
  floatMesh.frustumCulled = false;
  const floatData = Array.from({ length: FLOAT_COUNT }, (_, i) => {
    const angle = (i / FLOAT_COUNT) * TAU + random() * 0.4;
    const ring = 0.72 + random() * 0.25;
    return {
      base: new THREE.Vector3(0.45 + Math.cos(angle) * 4.0 * ring, 0.35 + Math.sin(angle) * 2.9 * ring, -1 + random() * 2.2),
      size: 0.04 + random() * 0.055, speed: 0.5 + random() * 0.8, phase: random() * TAU,
    };
  });
  stage.add(splashMesh, floatMesh);

  // ---------- Coffee beans (InstancedMesh with per-bean colour) ----------
  const BEAN_COUNT = smallScreen ? 10 : 18;
  const beanMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.38, clearcoat: 0.5, clearcoatRoughness: 0.25, envMapIntensity: 1.1,
  });
  const beans = new THREE.InstancedMesh(createBeanGeometry(), beanMaterial, BEAN_COUNT);
  beans.frustumCulled = false;
  const beanColors = [0x3b2012, 0x4a2814, 0x2e170b, 0x57301a];
  const color = new THREE.Color();
  const beanData = Array.from({ length: BEAN_COUNT }, (_, i) => {
    const angle = (i / BEAN_COUNT) * TAU + random() * 0.35;
    const ring = 1.0 + random() * 0.3; // beans sit on an ellipse AROUND the cup and carafe
    beans.setColorAt(i, color.setHex(beanColors[Math.floor(random() * beanColors.length)]));
    return {
      base: new THREE.Vector3(0.45 + Math.cos(angle) * 4.0 * ring, 0.35 + Math.sin(angle) * 2.9 * ring, -3.2 + random() * 4.8),
      scale: 0.32 + random() * 0.26,
      bob: 0.25 + random() * 0.3, speed: 0.4 + random() * 0.6, phase: random() * TAU,
      spin: new THREE.Vector3(0.2 + random() * 0.5, 0.2 + random() * 0.5, 0.1 + random() * 0.4),
      tilt: new THREE.Vector3(random() * TAU, random() * TAU, random() * TAU),
    };
  });
  beans.instanceColor.needsUpdate = true;
  stage.add(beans);

  // ---------- Steam wisps (sprites with a soft gradient texture) ----------
  const steamTexture = radialTexture('255,248,236', 0.7);
  const steam = Array.from({ length: 6 }, (_, i) => {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: steamTexture, transparent: true, opacity: 0, depthWrite: false })
    );
    stage.add(sprite);
    return { sprite, x: (i % 2 ? 1 : -1) * (0.3 + random() * 0.35), z: (random() - 0.5) * 0.6, offset: i / 6 };
  });

  // ---------- Pointer + drag interaction ----------
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 }; // target + smoothed values (-1..1)
  const drag = { active: false, lastX: 0, lastY: 0, yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0 };
  let dirty = true; // used when reduced motion is on: only re-render when something changes

  const onWindowPointerMove = (event) => {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
  };
  const onPointerDown = (event) => {
    drag.active = true;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    canvas.setPointerCapture?.(event.pointerId);
    canvas.classList.add('is-dragging');
  };
  const onPointerMove = (event) => {
    if (!drag.active) return;
    drag.targetYaw = clamp(drag.targetYaw + (event.clientX - drag.lastX) * 0.008, -1.4, 1.4);
    drag.targetPitch = clamp(drag.targetPitch + (event.clientY - drag.lastY) * 0.004, -0.35, 0.35);
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    dirty = true;
  };
  const endDrag = () => {
    drag.active = false;
    canvas.classList.remove('is-dragging');
  };
  if (!reducedMotion) window.addEventListener('pointermove', onWindowPointerMove, { passive: true });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);
  canvas.addEventListener('webglcontextlost', (event) => event.preventDefault());

  // ---------- Responsive layout ----------
  const sideBySideQuery = window.matchMedia('(min-width: 901px)');
  let baseDistance = 11;

  function layout() {
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
    renderer.setSize(width, height, false); // false = don't touch the canvas CSS size
    camera.aspect = width / height;

    // Pull the camera back just enough that the whole scene fits both width and height
    const halfTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const needHeight = 6.3;
    const needWidth = 5.3;
    baseDistance = Math.max(needHeight / (2 * halfTan), needWidth / (2 * halfTan * camera.aspect));
    camera.position.z = baseDistance;
    camera.updateProjectionMatrix();

    // On desktop the headline is on the left, so shift the scene to the right
    const visibleWidth = 2 * baseDistance * halfTan * camera.aspect;
    const slack = visibleWidth / 2 - 2.75;
    const shiftX = sideBySideQuery.matches ? Math.max(0, Math.min(visibleWidth * 0.2, slack)) : 0;
    pivot.position.set(shiftX, sideBySideQuery.matches ? -0.1 : 0, 0);
    dirty = true;
  }
  const resizeObserver = new ResizeObserver(layout);
  resizeObserver.observe(container);
  layout();

  // ---------- Animation ----------
  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3();
  const levelPoint = new THREE.Vector3();
  let elapsed = reducedMotion ? 2.3 : 0; // reduced motion: freeze on a nice, mid-pour frame

  function update(dt) {
    if (!reducedMotion) elapsed += dt;
    const t = elapsed;

    // Smooth follow (exponential damping, frame-rate independent)
    const follow = 1 - Math.exp(-dt * 5);
    if (reducedMotion) {
      pivot.rotation.y = drag.targetYaw;
      pivot.rotation.x = drag.targetPitch;
    } else {
      pointer.sx += (pointer.x - pointer.sx) * follow;
      pointer.sy += (pointer.y - pointer.sy) * follow;
      if (!drag.active) { // drift back to the resting angle when you let go
        const back = 1 - Math.exp(-dt * 0.7);
        drag.targetYaw -= drag.targetYaw * back;
        drag.targetPitch -= drag.targetPitch * back;
      }
      drag.yaw += (drag.targetYaw - drag.yaw) * follow;
      drag.pitch += (drag.targetPitch - drag.pitch) * follow;
      pivot.rotation.y = drag.yaw + pointer.sx * 0.18 + Math.sin(t * 0.35) * 0.05;
      pivot.rotation.x = drag.pitch + pointer.sy * 0.06;

      // Subtle camera drift
      camera.position.x = Math.sin(t * 0.25) * 0.25;
      camera.position.y = Math.cos(t * 0.2) * 0.12;
    }
    camera.position.z = baseDistance;
    camera.lookAt(0, 0, 0);

    // Carafe rocks very slightly
    carafe.rotation.z = CARAFE_TILT + (reducedMotion ? 0 : Math.sin(t * 0.7) * 0.012);

    // Keep the coffee in the carafe level in WORLD space
    pivot.updateMatrixWorld(true);
    levelPoint.set(0, LIQUID_LEVEL + Math.sin(t * 1.3) * 0.015, 0);
    clipPlane.constant = stage.localToWorld(tmp.copy(levelPoint)).y;

    // Shader time
    streamMaterial.uniforms.uTime.value = t;
    surfaceMaterial.uniforms.uTime.value = t;

    // Splash droplets: each follows a simple parabola, restarting when it lands
    for (let i = 0; i < SPLASH_COUNT; i++) {
      const d = splashData[i];
      const tau = (t + d.offset * d.life) % d.life;
      const height = d.lift * tau - 0.5 * GRAVITY * tau * tau;
      const scale = d.size * (0.4 + 0.6 * Math.sin((Math.PI * tau) / d.life));
      dummy.position.set(
        STREAM_END_X + Math.cos(d.angle) * d.speed * tau * 0.5,
        SURFACE_Y + 0.02 + Math.max(height, 0),
        Math.sin(d.angle) * d.speed * tau * 0.5
      );
      dummy.scale.setScalar(scale);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      splashMesh.setMatrixAt(i, dummy.matrix);
    }
    splashMesh.instanceMatrix.needsUpdate = true;

    // Floating droplets bob gently
    for (let i = 0; i < FLOAT_COUNT; i++) {
      const d = floatData[i];
      dummy.position.set(d.base.x + Math.sin(t * d.speed + d.phase) * 0.1, d.base.y + Math.sin(t * d.speed * 1.3 + d.phase) * 0.22, d.base.z);
      dummy.scale.set(d.size, d.size * (1 + 0.12 * Math.sin(t * 2 + d.phase)), d.size);
      dummy.updateMatrix();
      floatMesh.setMatrixAt(i, dummy.matrix);
    }
    floatMesh.instanceMatrix.needsUpdate = true;

    // Beans float and tumble
    for (let i = 0; i < BEAN_COUNT; i++) {
      const b = beanData[i];
      dummy.position.set(b.base.x + Math.sin(t * b.speed + b.phase) * 0.12, b.base.y + Math.sin(t * b.speed * 0.9 + b.phase) * b.bob, b.base.z);
      dummy.rotation.set(b.tilt.x + t * b.spin.x, b.tilt.y + t * b.spin.y, b.tilt.z + t * b.spin.z);
      dummy.scale.setScalar(b.scale);
      dummy.updateMatrix();
      beans.setMatrixAt(i, dummy.matrix);
    }
    beans.instanceMatrix.needsUpdate = true;

    // Steam rises, grows and fades
    for (const s of steam) {
      const phase = (t * 0.12 + s.offset) % 1;
      s.sprite.position.set(s.x + Math.sin(phase * 6 + s.offset * 9) * 0.15, SURFACE_Y + 0.15 + phase * 1.7, s.z);
      s.sprite.scale.setScalar(0.5 + phase * 0.9);
      s.sprite.material.opacity = Math.sin(phase * Math.PI) * 0.14;
    }
  }

  let frameId = null;
  function tick() {
    frameId = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05); // clamp so a tab switch doesn't cause a jump
    if (reducedMotion && !dirty) return;          // reduced motion: skip rendering unless something changed
    update(dt);
    renderer.render(scene, camera);
    dirty = false;
  }
  const start = () => { if (frameId === null) { clock.getDelta(); frameId = requestAnimationFrame(tick); } };
  const stop = () => { if (frameId !== null) { cancelAnimationFrame(frameId); frameId = null; } };

  // Only render while the hero is actually on screen (saves battery and GPU)
  const visibilityObserver = new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop()), { threshold: 0 });
  visibilityObserver.observe(container);

  return {
    dispose() {
      stop();
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      window.removeEventListener('pointermove', onWindowPointerMove);
      pmrem.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}