/* ─────────────────────────────────────────────────────────────
 * IceCrystalCanvas — Surface Frost Shader
 *
 * Wipe mechanic (breaking stage):
 *   A 2D canvas (wipeCanvas prop) is painted by CardFreeze as the
 *   user drags over the frozen card. This canvas is uploaded as a
 *   THREE.CanvasTexture each frame. The shader reads it as uWipeTex:
 *   wherever the canvas is white (wiped), frost is masked out.
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
const FRAG = `
  precision highp float;

  uniform sampler2D uNoiseTex;
  uniform sampler2D uMainNormalMap;
  uniform sampler2D uSubNormalMap;
  uniform sampler2D uWipeTex;    // 2D canvas wipe trail — white = wiped
  uniform float     uFrost;
  uniform float     uTime;
  uniform float     uAspect;

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  float contrast(float x, float s) {
    return clamp((x - 0.5) * s + 0.5, 0.0, 1.0);
  }

  void main() {

    /* ── Wipe mask ─────────────────────────────────────────────
       wipe=1 where user has dragged; frost is fully cleared there. */
    float wipe = texture2D(uWipeTex, vUv).r;

    /* ── Aspect-correct UV for noise sampling ─────────────────── */
    vec2 uv = vec2(vUv.x * uAspect, vUv.y);
    vec3 mainNormal = texture2D(uMainNormalMap, vUv * vec2(1.0, 0.72) + vec2(uTime * 0.006, 0.0)).xyz * 2.0 - 1.0;
    vec3 subNormal  = texture2D(uSubNormalMap, vUv * vec2(2.4, 1.7) + vec2(-uTime * 0.012, uTime * 0.01)).xyz * 2.0 - 1.0;
    vec2 distortion = (mainNormal.xy * 0.045 + subNormal.xy * 0.022) * mix(0.08, 1.0, uFrost);
    vec2 frostUv = uv + distortion;

    /* ── LAYER 1 — frozenNoise ─────────────────────────────────── */
    float n1r = texture2D(uNoiseTex, frostUv * 0.38 + vec2(uTime * 0.002, 0.0)).r;
    float n1b = texture2D(uNoiseTex, frostUv * 0.24 + vec2(0.31, 0.19)).b;
    float frozenNoise = n1r * 0.65 + n1b * 0.35;

    /* ── LAYER 2 — frostNoise ──────────────────────────────────── */
    float rawFrost = texture2D(uNoiseTex, frostUv * 0.95 + vec2(0.53, 0.71)).r;
    float frostAmount = mix(-1.8, 0.0, uFrost);
    float frostNoise  = rawFrost * 1.7 + frostAmount;
    frostNoise = contrast(frostNoise, 1.6);

    /* ── LAYER 3 — highlightNoise ──────────────────────────────── */
    float n3 = texture2D(uNoiseTex, frostUv * 2.8 + vec2(0.73, 0.42)).r;
    float highlightNoise = smoothstep(0.78, 0.96, n3);

    frozenNoise *= uFrost;

    /* ── Build frost mask ──────────────────────────────────────── */
    float frostMask = mix(frozenNoise, highlightNoise, 0.3);
    frostMask += frostNoise;
    frostMask  = contrast(frostMask, 1.8);
    frostMask  = clamp(frostMask, 0.0, 1.0);

    /* ── Apply wipe mask — wiped areas clear to zero ───────────── */
    float clearFactor = 1.0 - smoothstep(0.15, 0.65, wipe);
    frostMask *= clearFactor;

    /* ── Frost colours ─────────────────────────────────────────── */
    vec3 frostTintThin  = vec3(0.82, 0.86, 1.05);
    vec3 frostTintThick = vec3(0.92, 0.96, 1.10);
    vec3 sceneTint      = vec3(0.90, 0.90, 1.03);

    float ridge = clamp(mainNormal.z * 0.5 + subNormal.z * 0.5, 0.0, 1.0);
    float frostMix = clamp(frozenNoise * 0.82 + ridge * 0.12, 0.0, 1.0);
    frostMix *= clearFactor;
    vec3 frostTint = mix(frostTintThin, frostTintThick, frostNoise);
    vec3 baseIce   = sceneTint;
    vec3 frostColor = mix(baseIce, frostTint, 0.70);
    vec3 highLightColor = mix(baseIce, vec3(1.0), 0.80);
    frostColor = mix(frostColor, highLightColor, highlightNoise * 0.30);
    frostColor = mix(baseIce, frostColor, frostMix);

    /* Subtle edge shimmer where ice meets wiped area             */
    float edgeShimmer = smoothstep(0.4, 0.6, wipe) * (1.0 - smoothstep(0.6, 0.8, wipe));
    frostColor = mix(frostColor, vec3(1.0), edgeShimmer * 0.5);

    /* Subtle internal shimmer                                    */
    float shimmer = (sin(uTime * 1.2 + vUv.x * 9.0 + vUv.y * 6.0) * 0.5 + 0.5)
                  * highlightNoise * 0.035;
    frostColor = clamp(frostColor + shimmer, 0.0, 1.0);

    float alpha = clamp(frostMask * 0.68 + ridge * 0.06 * uFrost * clearFactor, 0.0, 0.72);

    gl_FragColor = vec4(frostColor, alpha);
  }
`

interface Props {
  stage:              IceStage
  onUnfreezeComplete: () => void
  width:              number
  height:             number
  zIndex?:            number
  wipeCanvas?:        HTMLCanvasElement | null
}


export default function IceCrystalCanvas({ stage, onUnfreezeComplete, width, height, zIndex = 4, wipeCanvas }: Props) {
  const mountRef   = useRef<HTMLDivElement>(null)
  const rafRef     = useRef<number>(0)
  const twRef      = useRef<gsap.core.Tween | null>(null)
  const frostRef   = useRef({ v: 0 })
  const matRef     = useRef<THREE.ShaderMaterial | null>(null)
  const wipeTexRef = useRef<THREE.CanvasTexture | null>(null)

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
    const scene = new THREE.Scene()
    const CW = 1.0
    const CH = height / width

    const camera = new THREE.OrthographicCamera(
      -CW / 2,  CW / 2,
       CH / 2, -CH / 2,
      0.1, 20
    )
    camera.position.set(0, 0, 5)
    camera.lookAt(0, 0, 0)

    const geo = new THREE.PlaneGeometry(CW, CH)

    // ── Textures ──────────────────────────────────────────────
    const loader = new THREE.TextureLoader()
    const noiseTex = loader.load('/noise.webp', tex => {
      tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = true
    })
    const mainNormalTex = loader.load('/main-normal.webp', tex => {
      tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = true
    })
    const subNormalTex = loader.load('/sub-normal.webp', tex => {
      tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = true
    })

    // ── Blank 1×1 wipe texture (all black = no wipe) ─────────
    const blankWipe = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
    blankWipe.needsUpdate = true

    // ── Material ──────────────────────────────────────────────
    const mat = new THREE.ShaderMaterial({
      vertexShader:   VERT,
      fragmentShader: FRAG,
      transparent:    true,
      depthTest:      false,
      depthWrite:     false,
      side:           THREE.DoubleSide,
      uniforms: {
        uNoiseTex:      { value: noiseTex },
        uMainNormalMap: { value: mainNormalTex },
        uSubNormalMap:  { value: subNormalTex },
        uWipeTex:       { value: blankWipe },
        uFrost:         { value: 0 },
        uTime:          { value: 0 },
        uAspect:        { value: width / height },
      },
    })
    matRef.current = mat
    scene.add(new THREE.Mesh(geo, mat))

    // ── Render loop ───────────────────────────────────────────
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick)
      mat.uniforms.uFrost.value = frostRef.current.v
      mat.uniforms.uTime.value  = performance.now() / 1000
      // Mark wipe texture dirty each frame so canvas paints show up
      if (wipeTexRef.current) wipeTexRef.current.needsUpdate = true
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
      blankWipe.dispose()
      wipeTexRef.current?.dispose()
      wipeTexRef.current = null
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [width, height])

  // ── Wire up wipeCanvas → THREE.CanvasTexture ──────────────
  useEffect(() => {
    const mat = matRef.current
    if (!mat) return

    if (!wipeCanvas) {
      // Reset to blank when leaving breaking mode
      const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
      blank.needsUpdate = true
      wipeTexRef.current?.dispose()
      wipeTexRef.current = null
      mat.uniforms.uWipeTex.value = blank
      return
    }

    const tex = new THREE.CanvasTexture(wipeCanvas)
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    wipeTexRef.current?.dispose()
    wipeTexRef.current = tex
    mat.uniforms.uWipeTex.value = tex
  }, [wipeCanvas])

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
        position:       'absolute',
        inset:          0,
        width,
        height,
        clipPath:       'inset(0 round 11.17px)',
        WebkitClipPath: 'inset(0 round 11.17px)',
        pointerEvents:  'none',
        zIndex,
        opacity:        stage === 'idle' ? 0 : 1,
        transition:     'opacity 0.10s ease',
      }}
    />
  )
}
