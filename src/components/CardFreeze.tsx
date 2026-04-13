/* ═══════════════════════════════════════════════════════════
 * ANIMATION STORYBOARD — Depth-Stack Card Carousel + Freeze
 * ═══════════════════════════════════════════════════════════
 *
 * STACK GEOMETRY
 *   3 cards, 3 depth positions [0=front, 1=mid, 2=back]
 *   activeOffset: index of the card currently at pos 0 (front)
 *   pos = (cardIdx - activeOffset + N) % N
 *
 *   DEPTH[0]  front — scale 1.22, y=0,  x=0,   full opacity, zi=10
 *   DEPTH[1]  mid   — scale 1.08, y=18, x=-10, rotate -9°, 78% opacity, zi=5
 *   DEPTH[2]  back  — scale 0.96, y=34, x=+10, rotate +9°, 55% opacity, zi=1
 *
 * TRANSITION (Arrow / Swipe)
 *   advance(dir): setActiveOffset → each card's pos changes
 *   Incoming front card: stiff spring (stiffness 340, damping 32)
 *   Cards going back: softer spring (stiffness 240, damping 28)
 *   All 3 animate simultaneously, no sequential delay
 *
 * HOVER (front card only, pos === 0)
 *   3D tilt toward cursor via Framer Motion springs + perspective
 *   Lift: y −14px, scale × 1.04
 *   Parallax: bgLayer ±4px, midLayer ±9px via GSAP quickTo
 *   Glow: radial gradient tracks cursor
 *   Shimmer: directional sweep follows movement angle
 *   On leave: elastic spring settle
 *
 * FREEZE / BREAK / UNFREEZE
 *   Cards stay at depth positions; frost shader renders on front card
 *   Wipe mechanic clears frost → stage 'idle'
 * ═══════════════════════════════════════════════════════════ */

import {
  useRef, useState, useCallback, useEffect,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  motion, AnimatePresence, useReducedMotion,
  useMotionValue, useTransform, useSpring,
  animate as fmAnimate,
  type MotionValue,
} from 'framer-motion'
import IceCrystalCanvas, { type IceStage } from './IceCrystalCanvas'

// ─── CARD DATA ────────────────────────────────────────────
const CARDS = [
  { id: 'euro',   label: 'Euro',   symbol: '€', amount: '50,000', color: '#f02d55' },
  { id: 'dollar', label: 'Dollar', symbol: '$', amount: '50,000', color: '#2cac4d' },
  { id: 'naira',  label: 'Naira',  symbol: '₦', amount: '50,000', color: '#f5841e' },
]
const N = CARDS.length

// ─── LAYOUT ───────────────────────────────────────────────
const CONTAINER_W = 390
const CARD_AREA_H = 450
const CARD_W      = 309.202
const CARD_H      = 187.257
const CARD_BR     = 11.17
const CENTER_X    = 195
const CENTER_Y    = 225
const CARD_ROT    = 90   // portrait orientation (landscape dims rotated)

const BASE_LEFT = CENTER_X - CARD_W / 2
const BASE_TOP  = CENTER_Y - CARD_H / 2

// ─── DEPTH CONFIG ─────────────────────────────────────────
//  pos 0 = front  pos 1 = mid  pos 2 = back
type DepthLevel = { scale: number; y: number; x: number; rotate: number; opacity: number; zi: number }
const DEPTH: DepthLevel[] = [
  { scale: 1.22, y: 0,  x: 0,   rotate: CARD_ROT,     opacity: 1.00, zi: 10 },
  { scale: 1.08, y: 18, x: -10, rotate: CARD_ROT - 9,  opacity: 0.78, zi: 5  },
  { scale: 0.96, y: 34, x: 10,  rotate: CARD_ROT + 9,  opacity: 0.55, zi: 1  },
]

// ─── SPRING CONFIGS ───────────────────────────────────────
const SPR_FRONT = { type: 'spring' as const, stiffness: 340, damping: 32, mass: 1.0 }
const SPR_BACK  = { type: 'spring' as const, stiffness: 240, damping: 28, mass: 1.2 }

// ─── WIPE CONFIG ──────────────────────────────────────────
const WIPE_BRUSH_R   = 44
const WIPE_THRESHOLD = 0.90

const WIPE_CURSOR = (() => {
  const svg = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">` +
    `<circle cx="24" cy="24" r="20" fill="rgba(255,255,255,0.12)" stroke="white" stroke-width="1.5" stroke-dasharray="5 3"/>` +
    `<circle cx="24" cy="24" r="2.5" fill="white"/>` +
    `</svg>`
  )
  return `url("data:image/svg+xml,${svg}") 24 24, crosshair`
})()

// ─── HELPERS ─────────────────────────────────────────────
const inter = (w: number, s: number, lh: string, c: string, x?: CSSProperties): CSSProperties => ({
  fontFamily: "'Inter', sans-serif", fontWeight: w, fontSize: s,
  lineHeight: lh, color: c, margin: 0,
  fontFeatureSettings: "'ss11' 1,'calt' 0,'liga' 0", ...x,
})

// ─── CARD BODY ────────────────────────────────────────────
// depth: 1 = front card (full shadows), 0 = side card (reduced)
// glowRef    → radial spotlight following cursor (updated directly on mousemove)
// shimmerRef → directional sweep overlay        (updated directly on mousemove)
interface CardBodyProps {
  card:        typeof CARDS[number]
  shimmerRef?: (el: HTMLDivElement | null) => void
  glowRef?:    (el: HTMLDivElement | null) => void
  frozen?:     boolean
  depth?:      number
}

function CardBody({ card, shimmerRef, glowRef, frozen = false, depth = 1 }: CardBodyProps) {
  const sh = (a: number) => `rgba(14,18,27,${(a * depth).toFixed(2)})`
  return (
    <div style={{
      width: CARD_W, height: CARD_H,
      background: card.color,
      borderRadius: CARD_BR,
      overflow: 'hidden', position: 'relative', flexShrink: 0,
      transition: 'filter 0.55s ease',
      filter: frozen
        ? 'saturate(0.75) brightness(0.92)'
        : 'saturate(1) brightness(1) contrast(1)',
      boxShadow: [
        `0px 28px 56px -16px ${sh(0.32)}`,
        `0px 8px 20px -8px ${sh(0.18)}`,
        `0px 0px 0px 0.75px ${sh(0.06)}`,
      ].join(', '),
    }}>

      {/* ── Static effects ────────────────────────────────── */}
      <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {/* Gradient highlight */}
        <div style={{
          position: 'absolute', inset: 0, borderRadius: CARD_BR,
          background: 'linear-gradient(150deg, rgba(255,255,255,0.20) 0%, transparent 50%)',
        }} />
        {/* Inset gloss */}
        <div style={{
          position: 'absolute', inset: 0, borderRadius: CARD_BR,
          boxShadow: [
            'inset 0 2px 0 rgba(255,255,255,0.55)',
            'inset 0 -1px 0 rgba(255,255,255,0.12)',
            'inset 0 0 28px rgba(255,255,255,0.06)',
          ].join(', '),
        }} />
      </div>

      {/* ── Text content ──────────────────────────────────── */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {/* Label */}
        <p style={inter(500, 11, '16px', 'rgba(255,255,255,0.72)', {
          position: 'absolute', top: 15, left: 16, letterSpacing: '0.1px',
          textShadow: '0 1px 2px rgba(0,0,0,0.2)',
          textTransform: 'uppercase',
        })}>{card.label}</p>
        {/* Amount */}
        <p style={inter(700, 17, '22px', '#fff', {
          position: 'absolute', top: 11, right: 16, letterSpacing: '-0.5px',
          textShadow: '0 1px 4px rgba(0,0,0,0.22)', whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
        })}>{card.symbol}{card.amount}</p>
      </div>

      {/* ── GLOW — radial spotlight following cursor ─────────── */}
      <div ref={glowRef} aria-hidden style={{
        position: 'absolute', inset: 0, borderRadius: CARD_BR,
        opacity: 0, pointerEvents: 'none',
        mixBlendMode: 'overlay',
        transition: 'opacity 0.35s ease',
        background: 'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.28) 0%, transparent 55%)',
      }} />

      {/* ── SHIMMER — directional sweep ──────────────────────── */}
      <div ref={shimmerRef} aria-hidden style={{
        position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none',
        mixBlendMode: 'overlay', borderRadius: CARD_BR,
        transition: 'opacity 0.25s ease',
        background: 'linear-gradient(105deg, transparent 20%, rgba(255,255,255,0.22) 50%, transparent 80%)',
      }} />

      {/* ── FROZEN TINT ───────────────────────────────────────── */}
      <div aria-hidden style={{
        position: 'absolute', inset: 0, borderRadius: CARD_BR, pointerEvents: 'none',
        background: 'linear-gradient(145deg, rgba(162,218,248,0.22) 0%, rgba(200,235,252,0.12) 100%)',
        opacity: frozen ? 1 : 0,
        transition: 'opacity 0.5s ease',
      }} />
    </div>
  )
}

// ─── CARD SLOT ────────────────────────────────────────────
type Stage = 'idle' | 'freezing' | 'frozen' | 'breaking' | 'unfreezing'

interface SlotProps {
  pos:  0 | 1 | 2
  card: typeof CARDS[number]
  stage:       Stage
  iceStage:    IceStage
  showCardIce: boolean
  wipeCanvas?: HTMLCanvasElement | null
  onWipeMove?:            (e: ReactPointerEvent<HTMLDivElement>) => void
  onCardUnfreezeComplete?: () => void
}

function CardSlot({ pos, card, stage, iceStage, showCardIce, wipeCanvas, onWipeMove, onCardUnfreezeComplete }: SlotProps) {
  const isFront     = pos === 0
  const freezing    = stage === 'freezing' && isFront
  const canNavigate = stage === 'idle' || stage === 'frozen'
  const reduced     = useReducedMotion()

  // ── Base position MotionValues (animated to DEPTH[pos] on pos change) ──
  const baseX   = useMotionValue(DEPTH[pos].x)
  const baseY   = useMotionValue(DEPTH[pos].y)
  const baseSc  = useMotionValue(DEPTH[pos].scale)
  const baseRot = useMotionValue(DEPTH[pos].rotate)
  const baseOp  = useMotionValue(DEPTH[pos].opacity)

  useEffect(() => {
    const d   = DEPTH[pos]
    const spr = pos === 0 ? SPR_FRONT : SPR_BACK
    fmAnimate(baseX,   d.x,       spr)
    fmAnimate(baseY,   d.y,       spr)
    fmAnimate(baseSc,  d.scale,   spr)
    fmAnimate(baseRot, d.rotate,  spr)
    fmAnimate(baseOp,  d.opacity, spr)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos])

  // ── Hover: cursor tilt + lift + scale ─────────────────
  const SPR_TILT  = { stiffness: 300, damping: 28, mass: 0.9 }
  const SPR_HOVER = { stiffness: 260, damping: 22, mass: 0.85 }

  const cursorX    = useMotionValue(0.5)
  const cursorY    = useMotionValue(0.5)
  const sprCurX    = useSpring(cursorX, SPR_TILT)
  const sprCurY    = useSpring(cursorY, SPR_TILT)
  const rotX       = useTransform(sprCurY, [0, 0.5, 1], [ 12, 0, -12])
  const rotY       = useTransform(sprCurX, [0, 0.5, 1], [-16, 0,  16])
  const hoverY     = useMotionValue(0)
  const hoverSc    = useMotionValue(1)
  const hoverYSpr  = useSpring(hoverY,  SPR_HOVER)
  const hoverScSpr = useSpring(hoverSc, SPR_HOVER)

  const finalY  = useTransform([baseY,  hoverYSpr  as MotionValue<number>], ([a, b]: number[]) => a + b)
  const finalSc = useTransform([baseSc, hoverScSpr as MotionValue<number>], ([a, b]: number[]) => a * b)

  // Reset hover state whenever card leaves front position
  useEffect(() => {
    if (!isFront) {
      cursorX.set(0.5); cursorY.set(0.5)
      hoverY.set(0);    hoverSc.set(1)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFront])

  // ── Surface effect refs (glow + shimmer, no inner movement) ──
  const glowRef    = useRef<HTMLDivElement | null>(null)
  const shimmerRef = useRef<HTMLDivElement | null>(null)

  // Clear surface effects when not idle
  useEffect(() => {
    if (stage !== 'idle') {
      if (shimmerRef.current) shimmerRef.current.style.opacity = '0'
      if (glowRef.current)    glowRef.current.style.opacity    = '0'
    }
  }, [stage])

  const cardDepth = isFront ? 1 : 0.35

  return (
    <motion.div
      // Inject perspective so rotateX/rotateY look correct on the front card
      transformTemplate={isFront
        ? (_: unknown, generated: string) => `perspective(1200px) ${generated}`
        : undefined}
      onMouseMove={isFront && !reduced ? (e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const nx = (e.clientX - rect.left) / rect.width
        const ny = (e.clientY - rect.top)  / rect.height
        cursorX.set(nx)
        cursorY.set(ny)

        // Dynamic radial glow tracking cursor
        const gx = (nx * 100).toFixed(1)
        const gy = (ny * 100).toFixed(1)
        if (glowRef.current) {
          glowRef.current.style.background = `radial-gradient(circle at ${gx}% ${gy}%, rgba(255,255,255,0.30) 0%, transparent 58%)`
          glowRef.current.style.opacity = '1'
        }

        // Directional shimmer
        const dx = (nx - 0.5) * 2
        const dy = (ny - 0.5) * 2
        const angle = Math.atan2(dy, dx) * (180 / Math.PI)
        if (shimmerRef.current) {
          shimmerRef.current.style.background = `linear-gradient(${angle + 90}deg, transparent 15%, rgba(255,255,255,0.22) 50%, transparent 85%)`
          shimmerRef.current.style.opacity = '1'
        }
      } : undefined}
      onMouseEnter={isFront && canNavigate && !reduced ? () => {
        hoverY.set(-14)
        hoverSc.set(1.04)
      } : undefined}
      onMouseLeave={isFront ? () => {
        cursorX.set(0.5); cursorY.set(0.5)
        hoverY.set(0);    hoverSc.set(1)
        if (shimmerRef.current) shimmerRef.current.style.opacity = '0'
        if (glowRef.current)    glowRef.current.style.opacity    = '0'
      } : undefined}
      style={{
        position:    'absolute',
        left:        BASE_LEFT,
        top:         BASE_TOP,
        width:       CARD_W,
        height:      CARD_H,
        transformOrigin: 'center center',
        willChange:  'transform',
        cursor:      stage === 'breaking'
          ? 'default'
          : canNavigate
            ? (isFront ? 'grab' : 'pointer')
            : 'default',
        pointerEvents: stage === 'breaking' ? 'none' : 'auto',
        clipPath:       `inset(0 round ${CARD_BR}px)`,
        WebkitClipPath: `inset(0 round ${CARD_BR}px)`,
        x:       baseX,
        y:       isFront ? finalY : baseY,
        scale:   isFront ? finalSc : baseSc,
        opacity: baseOp,
        rotate:  baseRot,
        rotateX: isFront ? rotX : undefined,
        rotateY: isFront ? rotY : undefined,
        // z-order changes immediately so incoming card is always on top
        zIndex:  DEPTH[pos].zi,
      }}
    >
      <div style={{ width: '100%', height: '100%' }}>
        <CardBody
          card={card}
          shimmerRef={el => { shimmerRef.current = el }}
          glowRef={el    => { glowRef.current    = el }}
          frozen={showCardIce}
          depth={cardDepth}
        />
      </div>

      {/* ── Ice overlay ────────────────────────────────── */}
      <motion.div
        aria-hidden
        onPointerMove={onWipeMove}
        animate={{ opacity: showCardIce ? 1 : 0 }}
        transition={{ duration: showCardIce ? 0.28 : 0.12, ease: 'easeOut' }}
        style={{
          position:       'absolute',
          inset:          0,
          clipPath:       `inset(0 round ${CARD_BR}px)`,
          WebkitClipPath: `inset(0 round ${CARD_BR}px)`,
          boxShadow:      'inset 0 0 0 1px rgba(255,255,255,0.24)',
          pointerEvents:  onWipeMove ? 'auto' : 'none',
          cursor:         onWipeMove ? WIPE_CURSOR : 'default',
          zIndex:         6,
        }}
      >
        <div style={{
          position:           'absolute',
          inset:              0,
          backdropFilter:     'blur(8px) saturate(1.3) brightness(0.94)',
          WebkitBackdropFilter: 'blur(8px) saturate(1.3) brightness(0.94)',
        }} />
        <div style={{
          position: 'absolute',
          inset:    0,
          background: [
            'linear-gradient(180deg, rgba(34,42,54,0.03) 0%, rgba(18,24,32,0.07) 100%)',
            'radial-gradient(circle at 50% 45%, rgba(255,255,255,0.08) 0%, rgba(11,23,34,0) 52%)',
          ].join(', '),
        }} />
        <IceCrystalCanvas
          stage={showCardIce ? iceStage : 'idle'}
          onUnfreezeComplete={onCardUnfreezeComplete ?? (() => {})}
          width={CARD_W}
          height={CARD_H}
          zIndex={2}
          wipeCanvas={wipeCanvas}
        />
      </motion.div>

      {/* Cold flash burst on freeze start — front card only */}
      {isFront && (
        <AnimatePresence>
          {freezing && (
            <motion.div
              key="cold-flash"
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.55, 0] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.45, ease: 'easeOut', times: [0, 0.2, 1] }}
              style={{
                position: 'absolute', inset: 0,
                background: 'radial-gradient(ellipse at 50% 40%, rgba(186,230,255,0.75) 0%, rgba(147,213,253,0.35) 45%, transparent 70%)',
                borderRadius: CARD_BR,
                pointerEvents: 'none',
                zIndex: 5,
              }}
            />
          )}
        </AnimatePresence>
      )}
    </motion.div>
  )
}

// ─── MAIN COMPONENT ───────────────────────────────────────
export default function CardFreeze() {
  const [stage,        setStage]        = useState<Stage>('idle')
  const [activeOffset, setActiveOffset] = useState(0)
  const [wipeCanvas,   setWipeCanvas]   = useState<HTMLCanvasElement | null>(null)
  const [frozenCardId, setFrozenCardId] = useState<string | null>(null)

  const wipeCtxRef    = useRef<CanvasRenderingContext2D | null>(null)
  const wipeCountRef  = useRef(0)
  const wipeDoneRef   = useRef(false)

  // ── Defrost audio refs ────────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const reduced    = useReducedMotion()

  const idle       = stage === 'idle'
  const freezing   = stage === 'freezing'
  const frozen     = stage === 'frozen'
  const breaking   = stage === 'breaking'
  const unfreezing = stage === 'unfreezing'
  const wheelLocked = freezing || breaking || unfreezing

  const activeCard         = CARDS[activeOffset]
  const isActiveCardFrozen = frozenCardId === activeCard.id

  // ── Advance carousel ─────────────────────────────────
  const advance = useCallback((dir: -1 | 1) => {
    if (wheelLocked) return
    setActiveOffset(o => (o + dir + N) % N)
  }, [wheelLocked])

  // ── Auto-complete freeze → frozen ────────────────────
  useEffect(() => {
    if (!freezing) return
    const t = setTimeout(() => setStage('frozen'), 1300)
    return () => clearTimeout(t)
  }, [freezing])

  // ── Ice stage ────────────────────────────────────────
  const iceStage: IceStage = idle ? 'idle'
    : freezing             ? 'freezing'
    : (frozen || breaking) ? 'frozen'
    : 'unfreezing'

  const onUnfreezeComplete = useCallback(() => {
    setTimeout(() => {
      setStage('idle')
      setFrozenCardId(null)
    }, 160)
  }, [])

  // ── Wipe canvas init ─────────────────────────────────
  useEffect(() => {
    if (!breaking) {
      wipeCtxRef.current  = null
      wipeDoneRef.current = false
      setWipeCanvas(null)
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width  = Math.ceil(CARD_W)
    canvas.height = Math.ceil(CARD_H)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    wipeCtxRef.current   = ctx
    wipeCountRef.current = 0
    wipeDoneRef.current  = false
    setWipeCanvas(canvas)
  }, [breaking])

  // ── Defrost audio ────────────────────────────────────
  // ── Defrost audio ────────────────────────────────────
  // Global pointerdown starts the sound (pointerdown IS a valid autoplay gesture;
  // pointermove is NOT — that's why in-move play() was silently rejected).
  // Global pointerup/cancel stops it. Both bypass CSS pointer-events entirely.
  useEffect(() => {
    if (!breaking) {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
        audioRef.current = null
      }
      return
    }

    const audio = new Audio('/defrost.wav')
    audio.volume  = 0.72
    audio.preload = 'auto'
    audioRef.current = audio

    const start = () => {
      // Reset to beginning every wipe so each stroke plays fresh
      audio.currentTime = 0
      audio.play().catch(() => {})
    }
    const stop = () => {
      if (!audio.paused) {
        audio.pause()
        audio.currentTime = 0
      }
    }

    document.addEventListener('pointerdown',   start)
    document.addEventListener('pointerup',     stop)
    document.addEventListener('pointercancel', stop)

    return () => {
      document.removeEventListener('pointerdown',   start)
      document.removeEventListener('pointerup',     stop)
      document.removeEventListener('pointercancel', stop)
      audio.pause()
      audioRef.current = null
    }
  }, [breaking])

  // ── Paint wipe trail ─────────────────────────────────
  const onWipeMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.buttons === 0) return  // only paint while pointer is pressed
    const ctx = wipeCtxRef.current
    if (!ctx || wipeDoneRef.current) return

    const rect = e.currentTarget.getBoundingClientRect()
    // Screen → card UV: card is rotated 90° CW, so u=sy, v=1−sx
    const sx = (e.clientX - rect.left) / rect.width
    const sy = (e.clientY - rect.top)  / rect.height
    const cx = sy * CARD_W
    const cy = (1 - sx) * CARD_H

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, WIPE_BRUSH_R)
    grad.addColorStop(0,    'rgba(255,255,255,1)')
    grad.addColorStop(0.55, 'rgba(255,255,255,0.8)')
    grad.addColorStop(1,    'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(cx, cy, WIPE_BRUSH_R, 0, Math.PI * 2)
    ctx.fill()

    // Check coverage every 8 strokes
    wipeCountRef.current++
    if (wipeCountRef.current % 8 === 0) {
      const { width: W, height: H } = ctx.canvas
      const data  = ctx.getImageData(0, 0, W, H).data
      let white = 0
      for (let i = 0; i < data.length; i += 12) {
        if (data[i] > 80) white += 3
      }
      const coverage = white / (W * H)
      if (coverage >= WIPE_THRESHOLD && !wipeDoneRef.current) {
        wipeDoneRef.current = true
        if (audioRef.current) {
          audioRef.current.pause()
          audioRef.current.currentTime = 0
        }
        setTimeout(() => {
          setStage('idle')
          setFrozenCardId(null)
        }, 220)
      }
    }
  }, [])

  // ── Swipe detection ───────────────────────────────────
  const swipeStartX = useRef(0)
  const swipeMoved  = useRef(false)

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (wheelLocked) return
    e.currentTarget.setPointerCapture(e.pointerId)
    swipeStartX.current = e.clientX
    swipeMoved.current  = false
  }, [wheelLocked])

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (Math.abs(e.clientX - swipeStartX.current) > 8) swipeMoved.current = true
  }, [])

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (wheelLocked) return
    const dx = e.clientX - swipeStartX.current
    if (Math.abs(dx) > 50 && swipeMoved.current) {
      advance(dx < 0 ? 1 : -1)
    }
  }, [wheelLocked, advance])

  // ─── RENDER ──────────────────────────────────────────────
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100svh', padding: '24px 0',
    }}>
      <div style={{
        width: CONTAINER_W, borderRadius: 20, background: '#ffffff',
        overflow: 'hidden', position: 'relative',
        boxShadow: [
          '0px 0px 0px 1px rgba(51,51,51,0.04)',
          '0px 16px 8px -8px rgba(51,51,51,0.01)',
          '0px 12px 6px -6px rgba(51,51,51,0.02)',
          '0px 5px 5px -2.5px rgba(51,51,51,0.08)',
          '0px 1px 3px -1.5px rgba(51,51,51,0.16)',
          'inset 0px -0.5px 0.5px 0px rgba(51,51,51,0.08)',
        ].join(', '),
      }}>

        {/* ── Card area ──────────────────────────────────── */}
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          style={{
            position:  'relative',
            width:     CONTAINER_W,
            height:    CARD_AREA_H,
            overflow:  'hidden',
            background: '#ffffff',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            touchAction: 'none',
          }}
        >
          {CARDS.map((card, cardIdx) => {
            const pos = ((cardIdx - activeOffset) % N + N) % N as 0 | 1 | 2
            return (
              <CardSlot
                key={card.id}
                pos={pos}
                card={card}
                stage={stage}
                iceStage={iceStage}
                showCardIce={card.id === frozenCardId && iceStage !== 'idle'}
                wipeCanvas={card.id === frozenCardId && breaking ? wipeCanvas : null}
                onWipeMove={card.id === frozenCardId && breaking ? onWipeMove   : undefined}
                onCardUnfreezeComplete={card.id === frozenCardId ? onUnfreezeComplete : undefined}
              />
            )
          })}
        </div>

        {/* ── Nav arrows — outside card area, siblings of card stack ── */}
        {([{ dir: -1 as const, left: 18 }, { dir: 1 as const, left: 340 }] as const).map(({ dir, left }) => (
          <motion.button
            key={dir}
            aria-label={dir === -1 ? 'Previous card' : 'Next card'}
            onClick={() => advance(dir)}
            disabled={wheelLocked}
            whileHover={!wheelLocked && !reduced ? { scale: 1.10 } : undefined}
            whileTap={{ scale: 0.88 }}
            transition={{ type: 'spring', stiffness: 700, damping: 38 }}
            style={{
              position:  'absolute',
              top:       CENTER_Y - 16,
              left,
              width: 32, height: 32,
              borderRadius: '50%',
              border:       'none',
              background:   'rgba(255,255,255,0.82)',
              backdropFilter:       'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
              boxShadow: '0 1px 4px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.06)',
              display:    'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor:    wheelLocked ? 'default' : 'pointer',
              opacity:   wheelLocked ? 0.38 : 1,
              transition: 'opacity 0.2s ease',
              zIndex:    20,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
              {dir === -1
                ? <path d="M8.5 2.5 L4 7 L8.5 11.5" stroke="#444" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                : <path d="M5.5 2.5 L10 7 L5.5 11.5" stroke="#444" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              }
            </svg>
          </motion.button>
        ))}

        {/* ── Divider — 0.5px hairline on retina ───────── */}
        <div style={{ height: '0.5px', background: 'rgba(0,0,0,0.08)' }} />

        {/* ── CTA bar ───────────────────────────────────── */}
        <div style={{ padding: '14px 16px 20px' }}>
          <motion.button
            onClick={() => {
              if (idle || (frozen && !isActiveCardFrozen)) {
                setFrozenCardId(activeCard.id)
                setStage('freezing')
              }
              if (frozen && isActiveCardFrozen) {
                setStage('breaking')
              }
            }}
            disabled={freezing || breaking || unfreezing}
            whileHover={!wheelLocked && !reduced ? { scale: 1.008 } : undefined}
            whileTap={!freezing && !unfreezing ? { scale: 0.974 } : undefined}
            transition={{ type: 'spring', stiffness: 700, damping: 42 }}
            style={{
              width: '100%', height: 44,
              borderRadius: CARD_BR,
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              gap:    8,
              cursor: (freezing || unfreezing) ? 'default' : 'pointer',
              WebkitTapHighlightColor: 'transparent',
              border: 'none',
              background: ((frozen && isActiveCardFrozen) || breaking)
                ? '#ffffff'
                : [
                    'linear-gradient(179.99deg, rgba(255,255,255,0.154) 6.67%, rgba(255,255,255,0) 103.33%)',
                    '#171717',
                  ].join(', '),
              boxShadow: ((frozen && isActiveCardFrozen) || breaking)
                ? '0px 0px 0px 1px #ebebeb, 0px 1px 3px 0px rgba(14,18,27,0.12)'
                : [
                    '0px 0px 0px 0.75px #171717',
                    '0px 5px 5px -2.5px rgba(51,51,51,0.08)',
                    '0px 1px 3px -1.5px rgba(51,51,51,0.16)',
                    'inset 0px 1px 2px 0px rgba(255,255,255,0.16)',
                  ].join(', '),
              opacity: (freezing || breaking || unfreezing) ? 0.55 : 1,
              transition: 'background 0.28s ease, border 0.28s ease, box-shadow 0.28s ease, opacity 0.28s ease',
            }}
          >
            {/* Icon */}
            <AnimatePresence mode="wait">
              {((frozen && isActiveCardFrozen) || breaking) ? (
                <motion.span key="sun"
                  initial={{ opacity: 0, rotate: -60, scale: 0.7 }}
                  animate={{ opacity: 1, rotate: 0, scale: 1 }}
                  exit={{ opacity: 0, rotate: 60, scale: 0.7 }}
                  transition={{ duration: 0.18 }}
                  style={{ display: 'flex' }}
                >
                  {/* Sun spins continuously while defrosting/unfreezing */}
                  <motion.span
                    animate={(breaking || unfreezing) ? { rotate: 360 } : { rotate: 0 }}
                    transition={(breaking || unfreezing)
                      ? { repeat: Infinity, duration: 2.4, ease: 'linear' }
                      : { duration: 0 }}
                    style={{ display: 'flex' }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <circle cx="12" cy="12" r="4.5" stroke="#5c5c5c" strokeWidth="1.9" />
                      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"
                        stroke="#5c5c5c" strokeWidth="1.9" strokeLinecap="round" />
                    </svg>
                  </motion.span>
                </motion.span>
              ) : (
                <motion.span key="snow"
                  initial={{ opacity: 0, rotate: 60, scale: 0.7 }}
                  animate={{ opacity: 1, rotate: 0, scale: 1 }}
                  exit={{ opacity: 0, rotate: -60, scale: 0.7 }}
                  transition={{ duration: 0.18 }}
                  style={{ display: 'flex' }}
                >
                  {/* Snowflake spins continuously while freezing */}
                  <motion.span
                    animate={freezing ? { rotate: 360 } : { rotate: 0 }}
                    transition={freezing
                      ? { repeat: Infinity, duration: 2.4, ease: 'linear' }
                      : { duration: 0 }}
                    style={{ display: 'flex' }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"
                        stroke="white" strokeWidth="1.9" strokeLinecap="round" />
                      <circle cx="12" cy="12" r="2" fill="none" stroke="white" strokeWidth="1.6" />
                    </svg>
                  </motion.span>
                </motion.span>
              )}
            </AnimatePresence>

            {/* Label — named card */}
            <AnimatePresence mode="wait">
              <motion.span
                key={`${stage}-${activeOffset}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
                style={inter(500, 14, '20px',
                  ((frozen && isActiveCardFrozen) || breaking) ? '#5c5c5c' : '#ffffff',
                  { letterSpacing: '-0.084px', pointerEvents: 'none' }
                )}
              >
                {idle       && `Freeze ${activeCard.label} card`}
                {freezing   && 'Freezing…'}
                {frozen && isActiveCardFrozen  && `Unfreeze ${activeCard.label} card`}
                {frozen && !isActiveCardFrozen && `Freeze ${activeCard.label} card`}
                {breaking   && 'Defrosting…'}
                {unfreezing && 'Unfreezing…'}
              </motion.span>
            </AnimatePresence>
          </motion.button>
        </div>

      </div>
    </div>
  )
}
