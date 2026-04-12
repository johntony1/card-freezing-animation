/* ─────────────────────────────────────────────────────────────
 * IceCrystalCanvas — Surface Frost Shader
 *
 * APPROACH: Replicates the reference site's compositing pipeline
 * using the SAME noise.webp texture the reference uses.
 *
 * Reference pipeline (3-pass → composite):
 *   frozenNoise  = main body (noise.webp large scale)
 *   frostNoise   = animated detail (noise.webp medium scale)
 *   highlightNoise = bright sparkle (noise.webp high threshold)
 *   → composite with exact reference uniform values
 *
 * Geometry: thin ExtrudeGeometry with bevel so the card edges
 * glow slightly via Fresnel (the "thicker edges" described in
 * the reference).
 *
 * CSS layer (in CardFreeze): backdrop-filter blur handles the
 * "blurry card visible through frost" dark-blob effect.
 * ───────────────────────────────────────────────────────────── */
import { useRef, useEffect } from 'react'
import * as THREE from 'three'
import gsap from 'gsap'

export type IceStage = 'idle' | 'freezing' | 'frozen' | 'unfreezing'

// ─── Vertex shader ────────────────────────────────────────────
const VERT = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    vUv      = uv;
    vec4 wp  = modelMatrix * vec4(position, 1.0);
    vNormal  = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

// ─── Fragment shader ──────────────────────────────────────────
// Reproduces the reference site's frost compositing shader using
// the same noise.webp texture. Parameters copied exactly from
// the reference's uniform defaults.
const FRAG = `
  precision highp float;

  uniform sampler2D uNoiseTex;   // noise.webp from reference project
  uniform sampler2D uMainNormalMap;
  uniform sampler2D uSubNormalMap;
  uniform float     uFrost;      // 0 = clear → 1 = fully frozen
  uniform float     uTime;
  uniform float     uAspect;     // canvas width / height  (≈ 1.652)

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  /* contrast() from the reference source (exact copy)          */
  float contrast(float x, float s) {
    return clamp((x - 0.5) * s + 0.5, 0.0, 1.0);
  }

  void main() {

    /* ── Aspect-correct UV for noise sampling ────────────────── */
    /* Canvas is landscape 309×187; correct so noise tiles square */
    vec2 uv = vec2(vUv.x * uAspect, vUv.y);
    vec3 mainNormal = texture2D(uMainNormalMap, vUv * vec2(1.0, 0.72) + vec2(uTime * 0.006, 0.0)).xyz * 2.0 - 1.0;
    vec3 subNormal  = texture2D(uSubNormalMap, vUv * vec2(2.4, 1.7) + vec2(-uTime * 0.012, uTime * 0.01)).xyz * 2.0 - 1.0;
    vec2 distortion = (mainNormal.xy * 0.045 + subNormal.xy * 0.022) * mix(0.08, 1.0, uFrost);
    vec2 frostUv = uv + distortion;

    /* ── LAYER 1 — frozenNoise ──────────────────────────────────
       Large-scale slow sweep — lower UV scale = bigger blobs.
       Two samples blended across R and B channels for variety.  */
    float n1r = texture2D(uNoiseTex, frostUv * 0.38 + vec2(uTime * 0.002, 0.0)).r;
    float n1b = texture2D(uNoiseTex, frostUv * 0.24 + vec2(0.31, 0.19)).b;
    float frozenNoise = n1r * 0.65 + n1b * 0.35;

    /* ── LAYER 2 — frostNoise (the animated reveal layer) ───────
       Medium scale — organic sweeping patches.
       frostStrength = 1.7, frostContrast = 1.6 (reference values) */
    float rawFrost = texture2D(uNoiseTex, frostUv * 0.95 + vec2(0.53, 0.71)).r;

    /* Map uFrost (0→1) to the reference's frostAmount (-1.8→0)  */
    float frostAmount = mix(-1.8, 0.0, uFrost);
    float frostNoise  = rawFrost * 1.7 + frostAmount;
    frostNoise = contrast(frostNoise, 1.6);   /* frostContrast   */

    /* ── LAYER 3 — highlightNoise (bright sparkle patches) ─────
       Slightly coarser sparkle so individual patches are visible. */
    float n3 = texture2D(uNoiseTex, frostUv * 2.8 + vec2(0.73, 0.42)).r;
    float highlightNoise = smoothstep(0.78, 0.96, n3);

    /* ── Scale frozenNoise by uFrost so nothing shows at uFrost=0 */
    frozenNoise *= uFrost;

    /* ── Build frost mask (reference logic exactly) ─────────────
       highlightMix = 0.3, maskContrast = 1.8                    */
    float frostMask = mix(frozenNoise, highlightNoise, 0.3);
    frostMask += frostNoise;
    frostMask  = contrast(frostMask, 1.8);
    frostMask  = clamp(frostMask, 0.0, 1.0);

    /* ── Frost colours ──────────────────────────────────────────
       Frosted glass: thin areas are translucent blue-white,
       thick areas are near-opaque white. Pure ice tones — no
       purple, no scene mixing. CSS blur layer below provides
       the blurred card colours (red/green/orange blobs).        */
    vec3 frostTintThin  = vec3(0.82, 0.86, 1.05);
    vec3 frostTintThick = vec3(0.92, 0.96, 1.10);
    vec3 sceneTint      = vec3(0.90, 0.90, 1.03);

    float ridge = clamp(mainNormal.z * 0.5 + subNormal.z * 0.5, 0.0, 1.0);
    float frostMix = clamp(frozenNoise * 0.82 + ridge * 0.12, 0.0, 1.0);
    vec3 frostTint = mix(frostTintThin, frostTintThick, frostNoise);
    vec3 baseIce   = sceneTint;
    vec3 frostColor = mix(baseIce, frostTint, 0.70);
    vec3 highLightColor = mix(baseIce, vec3(1.0), 0.80);
    frostColor = mix(frostColor, highLightColor, highlightNoise * 0.30);
    frostColor = mix(baseIce, frostColor, frostMix);

    /* Subtle internal shimmer (ice glint)                       */
    float shimmer = (sin(uTime * 1.2 + vUv.x * 9.0 + vUv.y * 6.0) * 0.5 + 0.5)
                  * highlightNoise * 0.035;
    frostColor = clamp(frostColor + shimmer, 0.0, 1.0);

    /* ── Alpha: frostMask = where frost canvas is opaque ────────
       LOW alpha → CSS blur layer shows through → card colors
       (red, green, orange blobs) visible as in reference image.
       HIGH alpha → frost colour covers → white/light-blue frost.
       Cap at 0.88 so blurred card colours always bleed through.  */
    float alpha = clamp(frostMask * 0.68 + ridge * 0.06 * uFrost, 0.0, 0.72);

    gl_FragColor = vec4(frostColor, alpha);
  }
`

interface Props {
  stage:              IceStage
  onUnfreezeComplete: () => void
  width:              number
  height:             number
  zIndex?:            number
}


export default function IceCrystalCanvas({ stage, onUnfreezeComplete, width, height, zIndex = 4 }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const rafRef   = useRef<number>(0)
  const twRef    = useRef<gsap.core.Tween | null>(null)
  const frostRef = useRef({ v: 0 })
  const matRef   = useRef<THREE.ShaderMaterial | null>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    // ── Renderer ─────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setSize(Math.ceil(width), Math.ceil(height))
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    // ── Scene + Camera ────────────────────────────────────────
    const scene  = new THREE.Scene()
    const CW = 1.0
    const CH = height / width   // ≈ 0.606

    const camera = new THREE.OrthographicCamera(
      -CW / 2,  CW / 2,
       CH / 2, -CH / 2,
      0.1, 20
    )
    camera.position.set(0, 0, 5)
    camera.lookAt(0, 0, 0)

    // ── Geometry: full-cover plane — fills the entire canvas
    // with no rounded corners so frost covers every pixel.
    const geo = new THREE.PlaneGeometry(CW, CH)

    // ── Noise texture (noise.webp from reference project) ─────
    const loader = new THREE.TextureLoader()
    const noiseTex = loader.load('/noise.webp', tex => {
      tex.wrapS          = THREE.RepeatWrapping
      tex.wrapT          = THREE.RepeatWrapping
      tex.minFilter      = THREE.LinearMipmapLinearFilter
      tex.magFilter      = THREE.LinearFilter
      tex.generateMipmaps = true
    })
    const mainNormalTex = loader.load('/main-normal.webp', tex => {
      tex.wrapS           = THREE.RepeatWrapping
      tex.wrapT           = THREE.RepeatWrapping
      tex.minFilter       = THREE.LinearMipmapLinearFilter
      tex.magFilter       = THREE.LinearFilter
      tex.generateMipmaps = true
    })
    const subNormalTex = loader.load('/sub-normal.webp', tex => {
      tex.wrapS           = THREE.RepeatWrapping
      tex.wrapT           = THREE.RepeatWrapping
      tex.minFilter       = THREE.LinearMipmapLinearFilter
      tex.magFilter       = THREE.LinearFilter
      tex.generateMipmaps = true
    })

    // ── Material ──────────────────────────────────────────────
    const mat = new THREE.ShaderMaterial({
      vertexShader:   VERT,
      fragmentShader: FRAG,
      transparent:    true,
      depthTest:      false,
      depthWrite:     false,
      side:           THREE.DoubleSide,
      uniforms: {
        uNoiseTex: { value: noiseTex },
        uMainNormalMap: { value: mainNormalTex },
        uSubNormalMap: { value: subNormalTex },
        uFrost:    { value: 0 },
        uTime:     { value: 0 },
        uAspect:   { value: width / height },   // canvas aspect ratio
      },
    })
    matRef.current = mat
    scene.add(new THREE.Mesh(geo, mat))

    // ── Render loop ───────────────────────────────────────────
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick)
      mat.uniforms.uFrost.value = frostRef.current.v
      mat.uniforms.uTime.value  = performance.now() / 1000
      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelAnimationFrame(rafRef.current)
      twRef.current?.kill()
      geo.dispose()
      mat.dispose()
      noiseTex.dispose()
      mainNormalTex.dispose()
      subNormalTex.dispose()
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [width, height])

  // ── Stage → GSAP animation ────────────────────────────────
  useEffect(() => {
    twRef.current?.kill()

    if (stage === 'idle') {
      frostRef.current.v = 0
      return
    }
    if (stage === 'freezing') {
      frostRef.current.v = 0
      const tl = gsap.timeline()
      tl.to(frostRef.current, { v: 0.28, duration: 0.22, ease: 'power4.out'   })
        .to(frostRef.current, { v: 1.00, duration: 0.80, ease: 'power2.inOut' })
      twRef.current = tl.getChildren()[0] as gsap.core.Tween
      return
    }
    if (stage === 'frozen') {
      frostRef.current.v = 1.0
      return
    }
    if (stage === 'unfreezing') {
      twRef.current = gsap.to(frostRef.current, {
        v:          0,
        duration:   0.40,
        ease:       'power4.in',
        onComplete: onUnfreezeComplete,
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage])

  return (
    <div
      ref={mountRef}
      aria-hidden
      style={{
        position:      'absolute',
        inset:         0,
        width,
        height,
        clipPath: 'inset(0 round 11.17px)',
        WebkitClipPath: 'inset(0 round 11.17px)',
        pointerEvents: 'none',
        zIndex,
        opacity:       stage === 'idle' ? 0 : 1,
        transition:    'opacity 0.10s ease',
      }}
    />
  )
}
