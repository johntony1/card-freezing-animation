/* ═══════════════════════════════════════════════════════════
 * ANIMATION STORYBOARD — Card Wheel + Freeze
 * ═══════════════════════════════════════════════════════════
 *
 * WHEEL GEOMETRY
 *   3 slots  [-1, 0, +1]
 *   dragX:   MotionValue<number> in pixels (single source of truth)
 *   wi:      useTransform(dragX, v => p + v / SPREAD) per slot
 *   All transforms derived from wi via useTransform — zero React
 *   re-renders during drag; 1:1 finger tracking.
 *
 *   Spread:   242px per slot
 *   Curve:    |wi|² × 22px  (y depth)
 *   Scale:    CENTRE_SCALE – |wi| × SCALE_STEP  (front card biggest)
 *   Rotate:   90° + wi × 5.2°  (landscape card → portrait fan)
 *
 * DRAG
 *   pointerdown → capture, record last x + time
 *   pointermove → dragX.set(dragX + movementX)  (instant, no RAF)
 *   pointerup   → compute momentum, update activeIdx,
 *                 normalise dragX, spring-snap to 0
 *   tap side card → snap to that card (no drag required)
 *
 * FREEZE
 *   0ms    Wheel locked; dragX → 0; all 3 cards spring to centre
 *          Side cards stack behind front card (y offset, smaller scale)
 *   180ms  Noise-texture frost shader grows over front card only
 *   720ms  Cold flash fades
 *   1300ms → 'frozen'
 *
 * BREAK (hammer mechanic)
 *   Click "Unfreeze" → stage = 'breaking', cursor = hammer
 *   Each click on ice: shockwave + crack SVG at cursor pos,
 *                      GSAP shake on card area
 *   3 hits → shatters → stage = 'unfreezing'
 *
 * UNFREEZE
 *   0ms    Ice dissolves (power4.in 0.44s)
 *   450ms  Cards spring back to fan (rot → idleRot, x → idleX)
 *   850ms  → 'idle', wheel re-enabled
 * ═══════════════════════════════════════════════════════════ */

import {
  useRef, useState, useCallback, useEffect, useLayoutEffect,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  motion, AnimatePresence, useReducedMotion,
  useMotionValue, useTransform,
  animate as fmAnimate,
  type MotionValue,
} from 'framer-motion'
import gsap from 'gsap'
import IceCrystalCanvas, { type IceStage } from './IceCrystalCanvas'

// ─── CARD DATA ────────────────────────────────────────────
const CARDS = [
  { id: 'euro',   label: 'Euro',   symbol: '€', amount: '50,000', color: '#f02d55' },
  { id: 'dollar', label: 'Dollar', symbol: '$', amount: '50,000', color: '#2cac4d' },
  { id: 'naira',  label: 'Naira',  symbol: '₦', amount: '50,000', color: '#f5841e' },
]
const N = CARDS.length

// ─── WHEEL CONFIG ─────────────────────────────────────────
const CONTAINER_W  = 390
const CARD_AREA_H  = 446
const CARD_W       = 309.202
const CARD_H       = 187.257
const CARD_BR      = 11.17
const CENTER_X     = 195
const CENTER_Y     = 223
const SPREAD       = 242
const CURVE        = 22
const SCALE_STEP   = 0.19
const CENTRE_SCALE = 1.16
const VISIBLE_DIST = 1.6
const CARD_ROT     = 90   // portrait orientation (landscape dims rotated)
const ROT_STEP     = 5.2  // side card fan slant (°)

// ─── SPRING CONFIGS ───────────────────────────────────────
const SPR = {
  snap:     { type: 'spring' as const, visualDuration: 0.52, bounce: 0.26 },
  freeze:   { type: 'spring' as const, visualDuration: 0.62, bounce: 0.08 },
  unfreeze: { type: 'spring' as const, visualDuration: 0.52, bounce: 0.30 },
}

const BASE_LEFT = CENTER_X - CARD_W / 2
const BASE_TOP  = CENTER_Y - CARD_H / 2
const SLOTS = [-1, 0, 1] as const

// ─── WIPE CONFIG ──────────────────────────────────────────
// Brush radius on the wipe canvas (card-space pixels, 309×187)
const WIPE_BRUSH_R = 44
// Fraction of card pixels that need to be wiped to auto-complete
const WIPE_THRESHOLD = 0.62

// Circular brush cursor — dashed ring showing brush size
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
// depth: 1 = front card (full shadows), 0 = side card (reduced shadows)
interface CardBodyProps {
  card: typeof CARDS[number]
  shimmerRef?: (el: HTMLDivElement | null) => void
  frozen?: boolean
  depth?: number
}

function CardBody({ card, shimmerRef, frozen = false, depth = 1 }: CardBodyProps) {
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
        `0px 24px 48px -16px ${sh(0.28)}`,
        `0px 8px 16px -8px ${sh(0.14)}`,
        `0px 0px 0px 0.75px ${sh(0.06)}`,
      ].join(', '),
    }}>
      {/* Inset gloss */}
      <div aria-hidden style={{
        position: 'absolute', inset: 0, borderRadius: CARD_BR, pointerEvents: 'none',
        boxShadow: [
          'inset 0 2px 0 rgba(255,255,255,0.55)',
          'inset 0 -1px 0 rgba(255,255,255,0.12)',
          'inset 0 0 28px rgba(255,255,255,0.06)',
        ].join(', '),
      }} />
      {/* Gradient highlight */}
      <div aria-hidden style={{
        position: 'absolute', inset: 0, borderRadius: CARD_BR, pointerEvents: 'none',
        background: 'linear-gradient(150deg, rgba(255,255,255,0.18) 0%, transparent 45%)',
      }} />
      {/* Label — secondary, lighter */}
      <p style={inter(500, 11, '16px', 'rgba(255,255,255,0.72)', {
        position: 'absolute', top: 15, left: 16, letterSpacing: '0.1px',
        textShadow: '0 1px 2px rgba(0,0,0,0.2)',
        textTransform: 'uppercase',
      })}>{card.label}</p>
      {/* Amount — primary fact */}
      <p style={inter(700, 17, '22px', '#fff', {
        position: 'absolute', top: 11, right: 16, letterSpacing: '-0.5px',
        textShadow: '0 1px 4px rgba(0,0,0,0.22)', whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      })}>{card.symbol}{card.amount}</p>
      {/* Shimmer overlay */}
      <div
        ref={shimmerRef}
        aria-hidden
        style={{
          position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none',
          mixBlendMode: 'overlay', borderRadius: CARD_BR,
          transition: 'opacity 0.25s ease',
          background: 'linear-gradient(105deg, transparent 20%, rgba(255,255,255,0.3) 50%, transparent 80%)',
        }}
      />
      {/* Frozen tint */}
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
  p: -1 | 0 | 1
  dragX: MotionValue<number>
  card: typeof CARDS[number]
  stage: Stage
  iceStage: IceStage
  showCardIce: boolean
  wipeCanvas?: HTMLCanvasElement | null
  onWipeMove?: (e: ReactPointerEvent<HTMLDivElement>) => void
  onCardUnfreezeComplete?: () => void
  onTap?: () => void
  wrapperRef: (el: HTMLDivElement | null) => void
  shimmerRef: (el: HTMLDivElement | null) => void
  iceRef?: (el: HTMLDivElement | null) => void
}

function CardSlot({
  p, dragX, card, stage, iceStage, showCardIce, wipeCanvas,
  onWipeMove, onCardUnfreezeComplete, onTap, wrapperRef, shimmerRef, iceRef,
}: SlotProps) {
  const freezing = stage === 'freezing' && p === 0
  const canNavigate = stage === 'idle' || stage === 'frozen'
  const unfreezing = stage === 'unfreezing'

  const wi  = useTransform(dragX, v => p + v / SPREAD)
  const tx  = useTransform(wi, v => v * SPREAD)
  const ty  = useTransform(wi, v => v * v * CURVE)
  const sc  = useTransform(wi, v => Math.max(0.45, CENTRE_SCALE - Math.abs(v) * SCALE_STEP))
  const op  = useTransform(wi, v => Math.abs(v) < VISIBLE_DIST ? 1 : 0)
  const rot = useTransform(wi, v => CARD_ROT + v * ROT_STEP)
  const zi  = useTransform(wi, v => Math.max(1, 10 - Math.round(Math.abs(v) * 3)))

  const idleX  = p * SPREAD
  const idleY  = p * p * CURVE
  const idleSc = Math.max(0.45, CENTRE_SCALE - Math.abs(p) * SCALE_STEP)
  const idleOp = Math.abs(p) < VISIBLE_DIST ? 1 : 0

  const animateTarget = unfreezing
    ? { x: idleX, y: idleY, scale: idleSc, rotate: CARD_ROT, opacity: idleOp }
    : undefined

  const animateTransition = unfreezing
    ? { ...SPR.unfreeze, delay: 0.42 + Math.abs(p) * 0.05 }
    : undefined

  const isSide = p !== 0
  const depth  = p === 0 ? 1 : 0.35

  return (
    <motion.div
      style={{
        position: 'absolute',
        left: BASE_LEFT, top: BASE_TOP,
        width: CARD_W, height: CARD_H,
        transformOrigin: 'center center',
        willChange: 'transform',
        cursor: isSide && canNavigate ? 'pointer' : p === 0 && canNavigate ? 'grab' : 'default',
        pointerEvents: stage === 'breaking' ? 'none' : 'auto',
        // clip frost to card shape
        clipPath: `inset(0 round ${CARD_BR}px)`,
        WebkitClipPath: `inset(0 round ${CARD_BR}px)`,
        x: tx,
        y: ty,
        scale: sc,
        opacity: op,
        rotate: rot,
        zIndex: zi,
      }}
      animate={animateTarget}
      transition={animateTransition}
      onClick={isSide && canNavigate ? onTap : undefined}
    >
      <div ref={wrapperRef} style={{ width: '100%', height: '100%' }}>
        <CardBody
          card={card}
          shimmerRef={shimmerRef}
          frozen={showCardIce}
          depth={depth}
        />
      </div>

      <motion.div
        ref={iceRef}
        aria-hidden
        onPointerMove={onWipeMove}
        animate={{ opacity: showCardIce ? 1 : 0 }}
        transition={{ duration: showCardIce ? 0.28 : 0.12, ease: 'easeOut' }}
        style={{
          position: 'absolute',
          inset: 0,
          clipPath: `inset(0 round ${CARD_BR}px)`,
          WebkitClipPath: `inset(0 round ${CARD_BR}px)`,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.24)',
          pointerEvents: onWipeMove ? 'auto' : 'none',
          cursor: onWipeMove ? WIPE_CURSOR : 'default',
          zIndex: 6,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backdropFilter: 'blur(8px) saturate(1.3) brightness(0.94)',
            WebkitBackdropFilter: 'blur(8px) saturate(1.3) brightness(0.94)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: [
              'linear-gradient(180deg, rgba(34,42,54,0.03) 0%, rgba(18,24,32,0.07) 100%)',
              'radial-gradient(circle at 50% 45%, rgba(255,255,255,0.08) 0%, rgba(11,23,34,0) 52%)',
            ].join(', '),
          }}
        />
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
      {p === 0 && (
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
  const [stage,       setStage]       = useState<Stage>('idle')
  const [activeIdx,   setActiveIdx]   = useState(0)
  const [wipeCanvas,  setWipeCanvas]  = useState<HTMLCanvasElement | null>(null)
  const [frozenCardId, setFrozenCardId] = useState<string | null>(null)

  // Wipe canvas refs — painted directly, no React re-render per stroke
  const wipeCtxRef    = useRef<CanvasRenderingContext2D | null>(null)
  const wipeCountRef  = useRef(0)   // paint call counter for coverage check throttle
  const wipeDoneRef   = useRef(false) // guard: only trigger unfreeze once

  const dragX    = useMotionValue(0)
  const isDragging  = useRef(false)
  const velRef      = useRef(0)
  const lastXRef    = useRef(0)
  const lastTRef    = useRef(0)
  const snapAnim    = useRef<ReturnType<typeof fmAnimate> | null>(null)

  const cardAreaRef  = useRef<HTMLDivElement>(null)
  const wrapperRefs  = useRef<(HTMLDivElement | null)[]>([null, null, null])
  const shimmerRefs  = useRef<(HTMLDivElement | null)[]>([null, null, null])
  const quickX       = useRef<(gsap.QuickToFunc | null)[]>([null, null, null])
  const quickY       = useRef<(gsap.QuickToFunc | null)[]>([null, null, null])

  const reduced = useReducedMotion()

  const idle       = stage === 'idle'
  const freezing   = stage === 'freezing'
  const frozen     = stage === 'frozen'
  const breaking   = stage === 'breaking'
  const unfreezing = stage === 'unfreezing'
  const wheelLocked = freezing || breaking || unfreezing

  const activeCard = CARDS[activeIdx]
  const isActiveCardFrozen = frozenCardId === activeCard.id

  // ── GSAP quickTo setup ───────────────────────────────────
  useLayoutEffect(() => {
    wrapperRefs.current.forEach((el, i: number) => {
      if (!el) return
      gsap.set(el, { transformPerspective: 900 })
      quickX.current[i] = gsap.quickTo(el, 'rotateY', { duration: 0.4, ease: 'power3.out' })
      quickY.current[i] = gsap.quickTo(el, 'rotateX', { duration: 0.4, ease: 'power3.out' })
    })
  }, [])

  // ── Clear tilt on freeze ─────────────────────────────────
  useEffect(() => {
    if (!idle) {
      wrapperRefs.current.forEach((el: HTMLDivElement | null) => {
        if (el) gsap.to(el, { rotateX: 0, rotateY: 0, duration: 0.3, ease: 'power2.out' })
      })
      shimmerRefs.current.forEach((sh: HTMLDivElement | null) => { if (sh) sh.style.opacity = '0' })
    }
  }, [idle])

  // ── Auto-complete freeze → frozen ────────────────────────
  useEffect(() => {
    if (!freezing) return
    const t = setTimeout(() => setStage('frozen'), 1300)
    return () => clearTimeout(t)
  }, [freezing])

  // ── Reset dragX when locking wheel ──────────────────────
  useEffect(() => {
    if (!idle) {
      snapAnim.current?.stop()
      dragX.set(0)
    }
  }, [idle, dragX])

  // ── Mouse tilt (front card only) ─────────────────────────
  const onMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (!idle || reduced) return
    const rect = cardAreaRef.current?.getBoundingClientRect()
    if (!rect) return
    const dx = ((e.clientX - rect.left)  / rect.width  - 0.5) * 2
    const dy = ((e.clientY - rect.top)   / rect.height - 0.5) * 2
    const angle = Math.atan2(dy, dx) * (180 / Math.PI)
    const fi = 1 // p=0 is index 1
    quickX.current[fi]?.(dx * 10)
    quickY.current[fi]?.(-dy * 10)
    const sh = shimmerRefs.current[fi]
    if (sh) {
      sh.style.background = `linear-gradient(${angle + 90}deg, transparent 15%, rgba(255,255,255,0.28) 50%, transparent 85%)`
      sh.style.opacity = '1'
    }
  }, [idle, reduced])

  const onMouseLeave = useCallback(() => {
    if (reduced) return
    wrapperRefs.current.forEach((el: HTMLDivElement | null) => {
      if (el) gsap.to(el, { rotateX: 0, rotateY: 0, duration: 0.7, ease: 'elastic.out(1,0.5)' })
    })
    shimmerRefs.current.forEach((sh: HTMLDivElement | null) => { if (sh) sh.style.opacity = '0' })
  }, [reduced])

  // ── Wipe canvas init — recreate when entering breaking ────
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
    wipeCtxRef.current  = ctx
    wipeCountRef.current = 0
    wipeDoneRef.current  = false
    setWipeCanvas(canvas)
  }, [breaking])

  // ── Paint wipe trail ─────────────────────────────────────
  const onWipeMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const ctx = wipeCtxRef.current
    if (!ctx || wipeDoneRef.current) return

    const rect = e.currentTarget.getBoundingClientRect()
    // Screen → card UV: card is rotated 90° CW, so u=sy, v=1-sx
    const sx = (e.clientX - rect.left) / rect.width
    const sy = (e.clientY - rect.top)  / rect.height
    const cx = sy * CARD_W
    const cy = (1 - sx) * CARD_H

    // Soft radial gradient brush
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
      // Sample every 3rd pixel (stride 12 in RGBA) for speed
      for (let i = 0; i < data.length; i += 12) {
        if (data[i] > 80) white += 3
      }
      const coverage = white / (W * H)
      if (coverage >= WIPE_THRESHOLD && !wipeDoneRef.current) {
        wipeDoneRef.current = true
        setTimeout(() => {
          setWipeCanvas(null)
          setStage('unfreezing')
        }, 220)
      }
    }
  }, [])

  // ── Pointer drag ─────────────────────────────────────────
  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (wheelLocked) return
    snapAnim.current?.stop()
    e.currentTarget.setPointerCapture(e.pointerId)
    isDragging.current = true
    velRef.current   = 0
    lastXRef.current = e.clientX
    lastTRef.current = performance.now()
  }, [wheelLocked, dragX])

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDragging.current) return
    const now = performance.now()
    const dt  = now - lastTRef.current
    if (dt > 0) velRef.current = (e.clientX - lastXRef.current) / dt
    lastXRef.current = e.clientX
    lastTRef.current = now
    dragX.set(dragX.get() + e.movementX)
  }, [dragX])

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDragging.current) return
    isDragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)

    const v         = dragX.get()
    const momentum  = velRef.current * 100
    const projected = v + momentum
    const delta     = Math.round(-projected / SPREAD)
    const clamped   = Math.max(-N + 1, Math.min(N - 1, delta))

    if (clamped !== 0) {
      setActiveIdx((i: number) => ((i + clamped) % N + N) % N)
      dragX.set(v + clamped * SPREAD)
    }

    snapAnim.current = fmAnimate(dragX, 0, SPR.snap)
  }, [dragX])

  // ── Tap side card to advance ─────────────────────────────
  const advanceTo = useCallback((p: -1 | 0 | 1) => {
    if (wheelLocked || p === 0) return
    setActiveIdx((i: number) => ((i + p) % N + N) % N)
    dragX.set(-p * SPREAD * 0.4)
    snapAnim.current = fmAnimate(dragX, 0, SPR.snap)
  }, [wheelLocked, dragX])

  // ── Ice stage ────────────────────────────────────────────
  // 'breaking' keeps the frost up (same as 'frozen') until shatter
  const iceStage: IceStage = idle ? 'idle'
    : freezing          ? 'freezing'
    : (frozen||breaking)? 'frozen'
    : 'unfreezing'

  const onUnfreezeComplete = useCallback(() => {
    setTimeout(() => {
      setStage('idle')
      setFrozenCardId(null)
    }, 160)
  }, [])

  // ─── RENDER ──────────────────────────────────────────────
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100svh', padding: '24px 0',
    }}>
      <div style={{
        width: CONTAINER_W, borderRadius: 20, background: '#ffffff',
        overflow: 'hidden',
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
          ref={cardAreaRef}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          style={{
            position: 'relative',
            width: CONTAINER_W,
            height: CARD_AREA_H,
            overflow: 'hidden',
            background: '#ffffff',
            cursor: wheelLocked ? 'default' : isDragging.current ? 'grabbing' : 'grab',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            touchAction: 'none',
          }}
        >
          {SLOTS.map((p, slotIdx) => {
            const cardIdx = ((activeIdx + p) % N + N) % N
            const slotCard = CARDS[cardIdx]
            return (
              <CardSlot
                key={slotCard.id}
                p={p}
                dragX={dragX}
                card={slotCard}
                stage={stage}
                iceStage={iceStage}
                showCardIce={slotCard.id === frozenCardId && iceStage !== 'idle'}
                wipeCanvas={slotCard.id === frozenCardId && breaking ? wipeCanvas : null}
                onWipeMove={slotCard.id === frozenCardId && breaking ? onWipeMove : undefined}
                onCardUnfreezeComplete={slotCard.id === frozenCardId ? onUnfreezeComplete : undefined}
                onTap={() => advanceTo(p)}
                wrapperRef={el => { wrapperRefs.current[slotIdx] = el }}
                shimmerRef={el => { shimmerRefs.current[slotIdx] = el }}
                iceRef={undefined}
              />
            )
          })}

          {/* ── "Tap to break" hint — fades after first hit ── */}
          <AnimatePresence>
            {breaking && (
              <motion.div
                key="tap-hint"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.3, delay: 0.15 }}
                style={{
                  position: 'absolute', bottom: 20, left: '50%',
                  transform: 'translateX(-50%)',
                  pointerEvents: 'none', zIndex: 15,
                  background: 'rgba(0,0,0,0.44)',
                  backdropFilter: 'blur(6px)',
                  WebkitBackdropFilter: 'blur(6px)',
                  borderRadius: 99, padding: '5px 14px',
                }}
              >
                <p style={inter(500, 12, '18px', 'rgba(255,255,255,0.88)', { letterSpacing: '0.02em' })}>
                  Swipe the card to clear the ice
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Divider ───────────────────────────────────── */}
        <div style={{ height: 1, background: 'rgba(0,0,0,0.06)' }} />

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
            whileTap={!freezing && !unfreezing ? { scale: 0.974 } : undefined}
            transition={{ type: 'spring', stiffness: 700, damping: 42 }}
            style={{
              width: '100%', height: 44,
              borderRadius: CARD_BR,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              cursor: (freezing || unfreezing) ? 'default' : 'pointer',
              outline: 'none',
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
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <circle cx="12" cy="12" r="4.5" stroke="#5c5c5c" strokeWidth="1.9" />
                    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"
                      stroke="#5c5c5c" strokeWidth="1.9" strokeLinecap="round" />
                  </svg>
                </motion.span>
              ) : (
                <motion.span key="snow"
                  initial={{ opacity: 0, rotate: 60, scale: 0.7 }}
                  animate={{ opacity: 1, rotate: 0, scale: 1 }}
                  exit={{ opacity: 0, rotate: -60, scale: 0.7 }}
                  transition={{ duration: 0.18 }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"
                      stroke="white" strokeWidth="1.9" strokeLinecap="round" />
                    <circle cx="12" cy="12" r="2" fill="none" stroke="white" strokeWidth="1.6" />
                  </svg>
                </motion.span>
              )}
            </AnimatePresence>

            {/* Label — named card */}
            <AnimatePresence mode="wait">
              <motion.span
                key={`${stage}-${activeIdx}`}
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
                {frozen && isActiveCardFrozen && `Unfreeze ${activeCard.label} card`}
                {frozen && !isActiveCardFrozen && `Freeze ${activeCard.label} card`}
                {breaking   && 'Breaking…'}
                {unfreezing && 'Unfreezing…'}
              </motion.span>
            </AnimatePresence>
          </motion.button>

        </div>

      </div>
    </div>
  )
}
