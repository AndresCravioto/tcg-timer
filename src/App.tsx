import React, { useEffect, useMemo, useRef, useState } from "react"

// --- Types ---
type TimerStatus = "RUNNING" | "PAUSED" | "FINISHED"

type GameTimer = {
  id: string
  game: string
  icon?: string // URL or emoji
  durationSec: number
  remainingSec: number
  status: TimerStatus
  announceAt: number[] // seconds remaining at which to announce (e.g., [300, 120])
  pinned?: boolean
}

// --- Utilities ---
const pad = (n: number) => String(n).padStart(2, "0")
const formatHHMMSS = (totalSeconds: number) => {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

const PRESETS: { label: string; icon: string; minutes: number }[] = [
  { label: "One Piece", icon: "🟡", minutes: 30 },
  { label: "Magic: The Gathering", icon: "🧙", minutes: 30 },
  { label: "Pokémon", icon: "⚡", minutes: 30 },
  { label: "Yu‑Gi‑Oh!", icon: "🜲", minutes: 45 },
  { label: "Lorcana", icon: "✨", minutes: 30 },
  { label: "Gundam", icon: "🤖", minutes: 30 },
  { label: "Riftbound", icon: "🌊", minutes: 30 },
]

// Speech synthesis helper (English/Spanish only) with a small queue so we don't overlap announcements.
function useSpeech(enabled: boolean, language?: 'en' | 'es') {
  const queue = useRef<string[]>([])
  const speaking = useRef(false)

  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => {
      if (speaking.current) return
      const next = queue.current.shift()
      if (!next) return
      const utter = new SpeechSynthesisUtterance(next)
      if (language) {
        const langPrefix = language.toLowerCase()
        const v = window.speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith(langPrefix))
        if (v) utter.voice = v
      }
      speaking.current = true
      utter.onend = () => (speaking.current = false)
      window.speechSynthesis.speak(utter)
    }, 250)
    return () => clearInterval(t)
  }, [enabled, language])

  return (text: string) => {
    if (!enabled) return
    queue.current.push(text)
  }
}

// Backdrop uploader (stores a data URL in localStorage)
function useBackdrop() {
  const [bg, setBg] = useState<string | undefined>(() => localStorage.getItem("tcg_bg") || undefined)
  const onFile = async (file: File) => {
    const url = await new Promise<string>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.readAsDataURL(file)
    })
    localStorage.setItem("tcg_bg", url)
    setBg(url)
  }
  const clear = () => {
    localStorage.removeItem("tcg_bg")
    setBg(undefined)
  }
  return { bg, onFile, clear }
}

// Simple audio assets manager for announcements (optional prerecorded audio)
function useAudioAssets() {
  type Kind = 'five' | 'two' | 'time'
  const key = (k: Kind) => `tcg_audio_${k}`
  const [assets, setAssets] = useState<{ five?: string; two?: string; time?: string }>(() => ({
    five: localStorage.getItem(key('five')) || undefined,
    two: localStorage.getItem(key('two')) || undefined,
    time: localStorage.getItem(key('time')) || undefined,
  }))

  const setFile = async (k: Kind, file: File) => {
    const url = await new Promise<string>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.readAsDataURL(file)
    })
    localStorage.setItem(key(k), url)
    setAssets((a) => ({ ...a, [k]: url }))
  }
  const clear = (k: Kind) => {
    localStorage.removeItem(key(k))
    setAssets((a) => {
      const c = { ...a } as any
      delete c[k]
      return c
    })
  }
  const play = (k: Kind) => {
    const src = (assets as any)[k] as string | undefined
    if (!src) return false
    const a = new Audio(src)
    a.play().catch(() => {})
    return true
  }
  return { assets, setFile, clear, play }
}

// Persist timers to localStorage so refreshes don't nuke your setup, and migrate old entries
function usePersistentTimers() {
  const [timers, setTimers] = useState<GameTimer[]>(() => {
    const raw = localStorage.getItem("tcg_timers")
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw) as any[]
      const safe = (parsed || []).map((t, i): GameTimer => {
        const id = t.id || (typeof crypto !== 'undefined' && (crypto as any).randomUUID ? crypto.randomUUID() : `${Date.now()}_${i}`)
        const durationSec = typeof t.durationSec === 'number' ? t.durationSec : Math.max(60, (t.minutes ? t.minutes * 60 : 3000))
        const remainingSec = Math.min(durationSec, typeof t.remainingSec === 'number' ? t.remainingSec : durationSec)
        const status: TimerStatus = t.status === 'RUNNING' || t.status === 'FINISHED' ? t.status : 'PAUSED'
        const announceAt = Array.isArray(t.announceAt) ? t.announceAt : [300, 120]
        return {
          id,
          game: t.game || 'Untitled Game',
          icon: t.icon || '🎮',
          durationSec,
          remainingSec,
          status,
          announceAt,
          pinned: !!t.pinned,
        }
      })
      return safe
    } catch {
      return []
    }
  })

  useEffect(() => {
    localStorage.setItem("tcg_timers", JSON.stringify(timers))
  }, [timers])

  return [timers, setTimers] as const
}

// --- Main Component ---
export default function TimerBoard() {
  const [timers, setTimers] = usePersistentTimers()
  const [showAdmin, setShowAdmin] = useState(true)
  const tickRateMs = 1000 // fixed; field removed from UI
  const [overlay, setOverlay] = useState<string | null>(null)
  const [speechEnabled, setSpeechEnabled] = useState(true)
  const [language, setLanguage] = useState<'en' | 'es'>('en')
  const speak = useSpeech(speechEnabled, language)
  const { bg, onFile: onBackdropFile, clear: clearBackdrop } = useBackdrop()
  const [displayMode, setDisplayMode] = useState(false) // minimal view
  const [blinkAtMin, setBlinkAtMin] = useState(3) // red/white blink when <= this many minutes
  const audio = useAudioAssets()

  // Key: allow ESC to exit Display Mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDisplayMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Ticking
  useEffect(() => {
    const t = setInterval(() => {
      setTimers((prev) =>
        prev.map((tm) => {
          if (tm.status !== "RUNNING") return tm
          const next = Math.max(0, tm.remainingSec - tickRateMs / 1000)
          return { ...tm, remainingSec: next, status: next <= 0 ? "FINISHED" : tm.status }
        })
      )
    }, tickRateMs)
    return () => clearInterval(t)
  }, [setTimers])

  // Announcements + Overlay when crossing milestones
  const lastSeen = useRef<Record<string, number>>({})
  useEffect(() => {
    timers.forEach((tm) => {
      if (tm.status === "FINISHED") {
        if (lastSeen.current[tm.id] !== -1) {
          if (!audio.play('time')) announce(`${tm.game}, tiempo, 3 turnos o 5 minutos.`)
          if (!displayMode) {
            setOverlay(`${tm.game}: TIME!`)
            setTimeout(() => setOverlay(null), 5000)
          }
          lastSeen.current[tm.id] = -1
        }
        return
      }
      const prev = lastSeen.current[tm.id]
      const remaining = Math.ceil(tm.remainingSec)
      if (tm.announceAt.includes(remaining) && prev !== remaining) {
        if (remaining === 300) {
          if (!audio.play('five')) announce(`${tm.game}, les quedan 5 minutos.`)
        } else if (remaining === 120) {
          if (!audio.play('two')) announce(`${tm.game}, les quedan 2 minutos.`)
        } else {
          announce(`${tm.game}, ${Math.floor(remaining / 60)} minutos restantes.`)
        }
        if (!displayMode) {
          setOverlay(`${tm.game}: ${formatHHMMSS(remaining)} left`)
          setTimeout(() => setOverlay(null), 3500)
        }
      }
      lastSeen.current[tm.id] = remaining
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timers, displayMode])

  function announce(text: string) {
    if (language === 'es') {
      text = text
        .replace('you have 5 minutes remaining', 'les quedan 5 minutos')
        .replace('only 2 minutes left', 'solo quedan 2 minutos')
        .replace('time! 3 turns or 5 more minutes.', '¡tiempo! 3 turnos o 5 minutos.')
    }
    speak(text)
  }

  function addTimer(preset?: { game?: string; icon?: string; minutes?: number }) {
    const id = crypto.randomUUID()
    const duration = (preset?.minutes ?? 50) * 60
    const nt: GameTimer = {
      id,
      game: preset?.game || "Untitled Game",
      icon: preset?.icon,
      durationSec: duration,
      remainingSec: duration,
      status: "PAUSED",
      announceAt: [300, 120],
      pinned: false,
    }
    setTimers((t) => [...t, nt])
  }

  function updateTimer(id: string, patch: Partial<GameTimer>) {
    setTimers((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  }

  function removeTimer(id: string) {
    setTimers((t) => t.filter((x) => x.id !== id))
    delete lastSeen.current[id]
  }

  const running = useMemo(() => timers.filter((t) => t.status !== "FINISHED"), [timers])
  const pinned = useMemo(() => timers.filter((t) => t.pinned && t.status !== 'FINISHED'), [timers])
  const source = pinned.length ? pinned : (running.length ? running : timers)
  const displayList = displayMode ? source.slice(0, 4) : timers // up to 4 in display mode
  const count = displayMode ? displayList.length : running.length || timers.length || 1

  // --- Pure Display for 1 timer ---
  if (displayMode && count === 1) {
    const tm = displayList[0]
    const shouldBlink = tm.remainingSec <= blinkAtMin * 60 && tm.status !== 'FINISHED'
    const minutesLeft = Math.ceil(tm.remainingSec / 60)

    return (
      <div className="w-full h-screen relative text-white">
        {/* Inline CSS for red/white blink */}
        <style>{`
          @keyframes redwhite { 0%{color:#ffffff} 50%{color:#f87171} 100%{color:#ffffff} }
          .blink-red-white { animation: redwhite 1s steps(1,end) infinite; }
        `}</style>
        <div
          className="absolute inset-0 bg-cover bg-center opacity-30 pointer-events-none"
          style={{ backgroundImage: bg ? `url(${bg})` : "linear-gradient(135deg,#0f172a,#1e293b)" }}
        />
        <div className="absolute inset-0 flex flex-col items-center justify-center z-10 p-6 text-center">
          <div className="text-3xl md:text-5xl font-bold drop-shadow mb-2">{tm.game}</div>
          <div
            className={`font-extrabold tracking-tight leading-none drop-shadow ${shouldBlink ? 'blink-red-white' : ''} pointer-events-none select-none`}
            style={{ fontSize: 'min(36vw, 75vh)' }}
          >
            {formatHHMMSS(tm.remainingSec)}
          </div>

          {/* Emphasis ribbon when in last X minutes */}
          {tm.remainingSec <= Math.max(blinkAtMin, 5) * 60 && (
            <div className="mt-4 text-white/90 text-2xl md:text-4xl font-bold border-2 border-red-400 rounded-2xl px-4 py-2 drop-shadow animate-pulse">
              {language === 'es' ? `¡Quedan ${minutesLeft} minuto${minutesLeft!==1?'s':''}!` : `${minutesLeft} minute${minutesLeft!==1?'s':''} left!`}
            </div>
          )}

          <button
            onClick={() => setDisplayMode(false)}
            className="absolute bottom-3 right-3 text-xs px-2 py-1 rounded-lg bg-black/30 border border-white/20 hover:bg-black/50"
            title="Exit Display"
          >
            Exit
          </button>
        </div>
      </div>
    )
  }

  // --- Pure Display for 2–4 timers: split halves or corners ---
  if (displayMode && count >= 2) {
    return (
      <DisplayWall
        list={displayList}
        bg={bg}
        blinkAtSec={blinkAtMin * 60}
        onExit={() => setDisplayMode(false)}
      />
    )
  }

  // --- Normal / Admin view ---
  return (
    <div className="w-full min-h-screen relative text-white">
      {/* Inline CSS for red/white blink */}
      <style>{`
        @keyframes redwhite { 0%{color:#ffffff} 50%{color:#f87171} 100%{color:#ffffff} }
        .blink-red-white { animation: redwhite 1s steps(1,end) infinite; }
      `}</style>

      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-cover bg-center opacity-30 pointer-events-none"
        style={{ backgroundImage: bg ? `url(${bg})` : "linear-gradient(135deg,#0f172a,#1e293b)" }}
      />

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto p-4">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-3xl font-bold drop-shadow">TCG Store Timers</h1>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <button
              onClick={() => setShowAdmin((v) => !v)}
              className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 backdrop-blur border border-white/20"
              title="Toggle admin controls"
            >
              {showAdmin ? "Hide Admin" : "Show Admin"}
            </button>
            <label className="flex items-center gap-2 text-sm bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
              <input
                type="checkbox"
                checked={speechEnabled}
                onChange={(e) => setSpeechEnabled(e.target.checked)}
              />
              Voice
            </label>
            <button
              onClick={() => setDisplayMode(true)}
              className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20"
              title="Minimal display (timers only)"
            >
              Display Mode
            </button>
          </div>
        </header>

        {/* Fullscreen toggle */}
        <div className="mt-2">
          <button
            onClick={() => {
              if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(() => {})
              } else {
                document.exitFullscreen().catch(() => {})
              }
            }}
            className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20"
          >
            Toggle Fullscreen
          </button>
        </div>

        {showAdmin && (
          <AdminPanel
            onAddTimer={addTimer}
            language={language}
            setLanguage={setLanguage}
            blinkAtMin={blinkAtMin}
            setBlinkAtMin={setBlinkAtMin}
            onBackdropFile={onBackdropFile}
            clearBackdrop={clearBackdrop}
            audio={audio}
          />
        )}

        {/* Timers Grid (normal view) */}
        <div className={`grid ${running.length <= 1 ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'} gap-4 mt-4`}>
          {timers.map((tm) => (
            <TimerCard
              key={tm.id}
              timer={tm}
              onUpdate={updateTimer}
              onRemove={removeTimer}
              minimal={false}
              blinkAtSec={blinkAtMin * 60}
              showPin={showAdmin}
            />
          ))}
          {timers.length === 0 && (
            <div className="rounded-3xl p-8 bg-black/30 border border-white/10 text-center">
              <p className="opacity-90">No timers yet. Use the admin panel to add a game timer.</p>
            </div>
          )}
      </div>
    </div>

      {/* Big overlay for milestones */}
      {overlay && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur pointer-events-none">
          <div className="text-5xl md:text-7xl font-extrabold text-white drop-shadow-xl animate-pulse">{overlay}</div>
        </div>
      )}
    </div>
  )
}

// --- Display Mode wall for 2–4 timers ---
function DisplayWall({ list, bg, blinkAtSec, onExit }: { list: GameTimer[]; bg?: string; blinkAtSec: number; onExit: () => void }) {
  const positions = (n: number): Array<'L'|'R'|'TL'|'TR'|'BL'|'BR'> => {
    if (n === 2) return ['L','R']
    if (n === 3) return ['TL','TR','BL']
    return ['TL','TR','BL','BR'] // 4
  }
  const pos = positions(Math.min(4, list.length))

  return (
    <div className="fixed inset-0 text-white">
      <style>{`
        @keyframes redwhite { 0%{color:#ffffff} 50%{color:#f87171} 100%{color:#ffffff} }
        .blink-red-white { animation: redwhite 1s steps(1,end) infinite; }
      `}</style>

      <div className="absolute inset-0 bg-cover bg-center opacity-30 pointer-events-none" style={{ backgroundImage: bg ? `url(${bg})` : "linear-gradient(135deg,#0f172a,#1e293b)" }} />

      {list.map((tm, i) => (
        <DisplayTile key={tm.id} tm={tm} where={pos[i]} blinkAtSec={blinkAtSec} />
      ))}

      <button onClick={onExit} className="fixed bottom-3 right-3 z-20 text-xs px-2 py-1 rounded-lg bg-black/30 border border-white/20 hover:bg-black/50">
        Exit
      </button>
    </div>
  )
}

function DisplayTile({ tm, where, blinkAtSec }: { tm: GameTimer; where: 'L'|'R'|'TL'|'TR'|'BL'|'BR'; blinkAtSec: number }) {
  const map: Record<string, string> = {
    'L':  'left-0 top-0 w-1/2 h-screen',
    'R':  'right-0 top-0 w-1/2 h-screen',
    'TL': 'left-0 top-0 w-1/2 h-1/2',
    'TR': 'right-0 top-0 w-1/2 h-1/2',
    'BL': 'left-0 bottom-0 w-1/2 h-1/2',
    'BR': 'right-0 bottom-0 w-1/2 h-1/2',
  }
  const fontSize = (where === 'L' || where === 'R') ? 'min(32vh, 22vw)' : 'min(20vh, 18vw)'
  const shouldBlink = tm.remainingSec <= blinkAtSec && tm.status !== 'FINISHED'

  return (
    <div className={`absolute ${map[where]} flex flex-col items-center justify-center p-3`}> 
      <div className="text-2xl md:text-4xl font-bold drop-shadow mb-2 text-center">{tm.game}</div>
      <div
        className={`font-extrabold tracking-tight leading-none drop-shadow ${shouldBlink ? 'blink-red-white' : ''} pointer-events-none select-none text-center`}
        style={{ fontSize }}
      >
        {formatHHMMSS(tm.remainingSec)}
      </div>
    </div>
  )
}

function TimerCard({
  timer,
  onUpdate,
  onRemove,
  minimal = false,
  blinkAtSec,
  showPin = false,
}: {
  timer: GameTimer
  onUpdate: (id: string, patch: Partial<GameTimer>) => void
  onRemove: (id: string) => void
  minimal?: boolean
  blinkAtSec: number
  showPin?: boolean
}) {
  const pct = Math.max(0, Math.min(100, 100 * (timer.remainingSec / timer.durationSec)))
  const isLow = timer.remainingSec <= 120 && timer.status !== "FINISHED"
  const shouldBlink = timer.remainingSec <= blinkAtSec && timer.status !== 'FINISHED'

  return (
    <div className={`rounded-3xl overflow-hidden border ${isLow ? "border-red-400/60" : "border-white/10"} bg-white/5`}> 
      {/* Header */}
      <div className="p-4 flex items-center justify-between gap-3 relative z-10 pointer-events-auto">
        <div className="flex items-center gap-3">
          <div className="text-3xl" title={timer.game}>{timer.icon || "🎮"}</div>
          <div>
            <div className="text-xl font-semibold leading-tight">{timer.game}</div>
            {!minimal && <div className="text-xs opacity-80">Total: {formatHHMMSS(timer.durationSec)}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {showPin && (
            <button
              onClick={() => onUpdate(timer.id, { pinned: !timer.pinned })}
              className={`text-sm px-3 py-1.5 rounded-xl border ${timer.pinned ? 'bg-amber-400/30 border-amber-300/40' : 'bg-white/10 hover:bg-white/20 border-white/20'}`}
              title="Show this timer in Display Mode"
            >
              {timer.pinned ? 'Pinned' : 'Pin to Display'}
            </button>
          )}
          <button
            onClick={() => onRemove(timer.id)}
            className="text-sm px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20"
          >
            Remove
          </button>
        </div>
      </div>

      {/* Big time */}
      <div className="px-4 relative z-0">
        <div
          className={`font-extrabold tracking-tight text-center drop-shadow leading-none ${shouldBlink ? 'blink-red-white' : 'text-white'} pointer-events-none select-none`}
          style={{ fontSize: 'min(18vw, 22vh)' }}
        >
          {formatHHMMSS(timer.remainingSec)}
        </div>
        {!minimal && (
          <div className="h-2 rounded-full bg-white/10 overflow-hidden mt-3">
            <div className={`h-full ${isLow ? "bg-red-400" : "bg-white"}`} style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      {/* Controls (hidden in Display Mode) */}
      {!minimal && (
      <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-2">
        <button
          onClick={() => onUpdate(timer.id, { status: timer.status === "RUNNING" ? "PAUSED" : "RUNNING" })}
          className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20"
        >
          {timer.status === "RUNNING" ? "Pause" : "Start"}
        </button>
        <button
          onClick={() => onUpdate(timer.id, { remainingSec: timer.durationSec, status: "PAUSED" })}
          className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20"
        >
          Reset
        </button>
        <button
          onClick={() => onUpdate(timer.id, { remainingSec: Math.max(0, timer.remainingSec - 60) })}
          className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20"
        >
          -1 min
        </button>
        <button
          onClick={() => onUpdate(timer.id, { remainingSec: timer.remainingSec + 60 })}
          className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20"
        >
          +1 min
        </button>
        <div className="col-span-2 md:col-span-4 grid grid-cols-2 gap-2">
          <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
            Minutes
            <input
              type="number"
              min={1}
              className="w-20 text-black rounded-xl px-2 py-1"
              value={Math.round(timer.durationSec / 60)}
              onChange={(e) => {
                const mins = Math.max(1, Number(e.target.value) || 1)
                const durationSec = mins * 60
                const remainingSec = Math.min(timer.remainingSec, durationSec)
                onUpdate(timer.id, { durationSec, remainingSec })
              }}
            />
          </label>
          <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
            Announce at (min, comma‑sep)
            <input
              type="text"
              className="text-black rounded-xl px-2 py-1 w-full"
              value={timer.announceAt.map((s) => Math.floor(s / 60)).join(",")}
              onChange={(e) => {
                const mins = e.target.value
                  .split(",")
                  .map((x) => Number(x.trim()))
                  .filter((x) => !isNaN(x) && x >= 0)
                onUpdate(timer.id, { announceAt: mins.map((m) => m * 60) })
              }}
            />
          </label>
        </div>
      </div>
      )}
    </div>
  )
}

function AdminPanel({
  onAddTimer,
  language,
  setLanguage,
  blinkAtMin,
  setBlinkAtMin,
  onBackdropFile,
  clearBackdrop,
  audio,
}: {
  onAddTimer: (preset?: { game?: string; icon?: string; minutes?: number }) => void
  language: 'en' | 'es'
  setLanguage: (v: 'en' | 'es') => void
  blinkAtMin: number
  setBlinkAtMin: (n: number) => void
  onBackdropFile: (f: File) => void
  clearBackdrop: () => void
  audio: { assets: { five?: string; two?: string; time?: string }; setFile: (k: 'five'|'two'|'time', f: File) => void; clear: (k: 'five'|'two'|'time') => void; play: (k: 'five'|'two'|'time') => boolean }
}) {
  const [minutes, setMinutes] = useState(PRESETS[0]?.minutes || 50)
  const [game, setGame] = useState(PRESETS[0]?.label || "Untitled Game")
  const [icon, setIcon] = useState(PRESETS[0]?.icon || "🎮")

  return (
    <div className="mt-4 p-4 rounded-3xl bg-black/30 border border-white/10">
      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((g) => (
              <button
                key={g.label}
                className={`px-3 py-2 rounded-2xl border ${game === g.label ? "bg-white/20 border-white/40" : "bg-white/10 border-white/20"}`}
                onClick={() => {
                  setGame(g.label)
                  setIcon(g.icon)
                  setMinutes(g.minutes)
                }}
              >
                <span className="mr-2">{g.icon}</span>
                {g.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
              Game
              <input
                className="text-black rounded-xl px-2 py-1 w-full"
                value={game}
                onChange={(e) => setGame(e.target.value)}
              />
            </label>
            <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
              Minutes
              <input
                type="number"
                min={1}
                className="text-black rounded-xl px-2 py-1 w-full"
                value={minutes}
                onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
              Icon (emoji)
              <input
                className="text-black rounded-xl px-2 py-1 w-full"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
              />
            </label>
            <button
              onClick={() => onAddTimer({ game, icon, minutes })}
              className="px-3 py-2 rounded-2xl bg-emerald-400/20 hover:bg-emerald-400/30 border border-emerald-300/40"
            >
              + Add Timer
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
              Language
              <select
                className="text-black rounded-xl px-2 py-1 w-full"
                value={language}
                onChange={(e) => setLanguage((e.target.value as 'en' | 'es') || 'en')}
              >
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </label>
            <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
              Blink when ≤ (min)
              <input
                type="number"
                min={1}
                className="text-black rounded-xl px-2 py-1 w-full"
                value={blinkAtMin}
                onChange={(e) => setBlinkAtMin(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
          </div>

          <div className="space-y-2">
            <div className="text-sm opacity-90">Announcement audio (optional)</div>
            <div className="grid md:grid-cols-3 gap-3">
              <div className="bg-white/10 p-3 rounded-2xl border border-white/20">
                <div className="text-xs opacity-80 mb-1">5‑minute</div>
                <input type="file" accept="audio/*" onChange={(e)=>{const f=e.target.files?.[0]; if(f) audio.setFile('five', f)}} />
                <div className="mt-2 flex gap-2">
                  <button className="text-xs px-2 py-1 rounded-xl bg-white/10 border border-white/20" onClick={()=>audio.play('five')}>Test</button>
                  <button className="text-xs px-2 py-1 rounded-xl bg-white/10 border border-white/20" onClick={()=>audio.clear('five')}>Clear</button>
                </div>
              </div>
              <div className="bg-white/10 p-3 rounded-2xl border border-white/20">
                <div className="text-xs opacity-80 mb-1">2‑minute</div>
                <input type="file" accept="audio/*" onChange={(e)=>{const f=e.target.files?.[0]; if(f) audio.setFile('two', f)}} />
                <div className="mt-2 flex gap-2">
                  <button className="text-xs px-2 py-1 rounded-xl bg-white/10 border border-white/20" onClick={()=>audio.play('two')}>Test</button>
                  <button className="text-xs px-2 py-1 rounded-xl bg-white/10 border border-white/20" onClick={()=>audio.clear('two')}>Clear</button>
                </div>
              </div>
              <div className="bg-white/10 p-3 rounded-2xl border border-white/20">
                <div className="text-xs opacity-80 mb-1">Time‑up</div>
                <input type="file" accept="audio/*" onChange={(e)=>{const f=e.target.files?.[0]; if(f) audio.setFile('time', f)}} />
                <div className="mt-2 flex gap-2">
                  <button className="text-xs px-2 py-1 rounded-xl bg-white/10 border border-white/20" onClick={()=>audio.play('time')}>Test</button>
                  <button className="text-xs px-2 py-1 rounded-xl bg-white/10 border border-white/20" onClick={()=>audio.clear('time')}>Clear</button>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="text-sm bg-white/10 px-3 py-2 rounded-2xl border border-white/20 cursor-pointer">
              <input
                type="file"
                className="hidden"
                accept="image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) onBackdropFile(f)
                }}
              />
              Set background image…
            </label>
            <button onClick={clearBackdrop} className="text-sm px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20">
              Clear background
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}