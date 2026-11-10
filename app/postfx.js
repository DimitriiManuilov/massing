/* ============================================================
   Финальный проход: наклонно-сдвиговое размытие, виньетка, зерно.

   Tilt-shift — не украшение, а смысловой приём: узкая полоса
   резкости и мягкие края читаются мозгом как малая глубина резкости
   при съёмке крупным планом, и городской керн начинает выглядеть
   макетом на столе, а не спутниковым снимком.

   Один проход, семь выборок по кольцу — дешевле честного боке и на
   таком материале неотличимо.
   ============================================================ */

export const TiltShiftShader = {
  name: 'TiltShiftShader',

  uniforms: {
    tDiffuse:  { value: null },
    resolution: { value: [1, 1] },
    focusCenter: { value: 0.5 },    // положение полосы резкости по вертикали
    focusWidth:  { value: 0.13 },   // половина ширины полностью резкой зоны
    falloff:     { value: 0.22 },   // насколько плавно нарастает размытие
    blurStrength: { value: 5.0 },   // радиус в пикселях на краю кадра
    vignette:    { value: 0.22 },
    grain:       { value: 0.018 },
    time:        { value: 0 }
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,

  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float focusCenter, focusWidth, falloff, blurStrength, vignette, grain, time;
    varying vec2 vUv;

    // дешёвый псевдослучайный шум для зерна
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      // Сила размытия: ноль в полосе резкости, дальше плавно вверх.
      float d = abs(vUv.y - focusCenter);
      float k = smoothstep(focusWidth, focusWidth + falloff, d);

      vec4 color = texture2D(tDiffuse, vUv);

      if (k > 0.001) {
        vec2 px = blurStrength * k / resolution;
        vec4 sum = color;
        // кольцо из шести выборок — на плавных градиентах керна
        // разница с многопроходным блюром незаметна
        for (int i = 0; i < 6; i++) {
          float a = float(i) * 1.0472;            // 60°
          sum += texture2D(tDiffuse, vUv + vec2(cos(a), sin(a)) * px);
        }
        color = sum / 7.0;
      }

      // Виньетка: слегка сажает углы, взгляд остаётся на объекте.
      float r = distance(vUv, vec2(0.5));
      color.rgb *= 1.0 - vignette * smoothstep(0.35, 0.95, r);

      // Зерно снимает «пластиковую» гладкость больших плоскостей.
      float n = hash(vUv * resolution + time) - 0.5;
      color.rgb += n * grain;

      gl_FragColor = color;
    }`
};
