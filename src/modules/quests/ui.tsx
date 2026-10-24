'use client'
import { hc } from 'hono/client'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useChannel } from '@/platform/realtime/use-channel'
import { Entity } from '@/ui/entity'
import { look } from '@/ui/theme'
import type { QuestsApi } from './api'
import { type DailyQuest, type DailyQuests, QUESTS_CHANNEL, type RewardStatus } from './contracts'
import { questDayAt, questInstanceId } from './domain/quest-day'

const client = hc<QuestsApi>('/api/quests')

const CONNECTION_LABELS = {
  connecting: 'Connexion au temps réel…',
  open: 'Temps réel connecté',
  reconnecting: 'Reconnexion au temps réel…',
} as const

const STATUS_LABELS: Record<RewardStatus, string> = {
  in_progress: 'En cours',
  available: 'Récompense disponible',
  village_required: 'Village requis',
  pending: 'Versement en attente',
  delivered: 'Récompense versée',
}

const ERRORS: Record<string, string> = {
  INVALID_INPUT: 'La date des quêtes est invalide. Actualisez les quêtes et réessayez.',
  QUEST_NOT_FOUND: 'Cette quête n’est pas disponible. Actualisez les quêtes.',
  ALREADY_CLAIMED: 'Cette récompense a déjà été réclamée. Consultez son état actualisé.',
  NOT_CURRENT_DAY: 'Une nouvelle journée de quêtes a commencé. Consultez les quêtes actualisées.',
  VILLAGE_REQUIRED: 'Fondez un village avant de récupérer cette récompense.',
  QUEST_INCOMPLETE: 'Cette quête n’est pas encore terminée.',
  QUESTS_NOT_READY:
    'La progression des quêtes est en cours de mise à jour. Cliquez sur « Actualiser » pour réessayer.',
}

async function errorText(response: Response): Promise<string> {
  if (response.status === 401) {
    window.location.href = '/login'
    return 'Votre session a expiré. Redirection vers la connexion…'
  }
  if (response.status === 503) return ERRORS.QUESTS_NOT_READY
  try {
    const body = await response.json()
    return (
      ERRORS[body.error?.code] ?? 'La demande a échoué. Cliquez sur « Actualiser » pour réessayer.'
    )
  } catch {
    return 'La demande a échoué. Cliquez sur « Actualiser » pour réessayer.'
  }
}

export function QuestCard({
  quest,
  disabled,
  onClaim,
}: {
  quest: DailyQuest
  disabled: boolean
  onClaim: (id: DailyQuest['id']) => void
}) {
  const titleId = `quest-${quest.id}`
  return (
    <section className="panel" aria-labelledby={titleId}>
      <h2 id={titleId}>{quest.name}</h2>
      <p>{quest.objective}</p>
      <p>
        Récompense :{' '}
        {`${look(quest.reward.resource).glyph} ${quest.reward.amount} ${look(quest.reward.resource).label.toLowerCase()}`}
      </p>
      <div className="row">
        <progress
          aria-label={`Progression : ${quest.name}`}
          value={quest.progress}
          max={quest.requiredCount}
        />
        <span>Progression : {`${quest.progress}/${quest.requiredCount}`}</span>
      </div>
      <p className="muted">{STATUS_LABELS[quest.rewardStatus]}</p>
      <div className="row">
        <button
          type="button"
          aria-label={`Récupérer la récompense : ${quest.name}`}
          disabled={disabled || quest.rewardStatus !== 'available'}
          onClick={() => onClaim(quest.id)}
        >
          Récupérer la récompense
        </button>
        {quest.rewardStatus === 'village_required' && (
          <Link href="/village">Fonder un village</Link>
        )}
      </div>
    </section>
  )
}

export function QuestsScreen() {
  const [data, setData] = useState<DailyQuests>()
  const [busy, setBusy] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [message, setMessage] = useState<{
    text: string
    error: boolean
  } | null>(null)
  const working = useRef(false)
  const refreshRequested = useRef(false)
  const refreshAt = useRef(0)

  const load = useCallback(async () => {
    do {
      refreshRequested.current = false
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // A response crossing local UTC midnight must trigger another read before enabling claims.
          const now = new Date()
          const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
          const response = await client.index.$get()
          // A journal gap can briefly prevent projection catch-up; only retry this response.
          if (response.status === 503 && attempt < 2) {
            await new Promise((resolve) => window.setTimeout(resolve, 1_000))
            continue
          }
          if (!response.ok) {
            setLoadError(await errorText(response))
          } else {
            const body = await response.json()
            refreshAt.current = boundary
            setData({
              ...body,
              day: questDayAt(Date.parse(`${body.day}T00:00:00.000Z`)),
            })
            setLoadError(null)
          }
        } catch {
          setLoadError(
            'Impossible de charger les quêtes. Cliquez sur « Actualiser » pour réessayer.',
          )
        }
        break
      }
      // Notifications received during a read require another authoritative snapshot.
    } while (refreshRequested.current)
  }, [])

  const refresh = useCallback(async () => {
    if (working.current) {
      refreshRequested.current = true
      return
    }
    working.current = true
    setBusy(true)
    try {
      await load()
    } finally {
      working.current = false
      setBusy(false)
    }
  }, [load])

  const status = useChannel(QUESTS_CHANNEL, () => {
    void refresh()
  })

  useEffect(() => {
    // Re-read after opening as well as reconnecting to close the initial subscription gap.
    if (status === 'open') void refresh()
  }, [status, refresh])

  useEffect(() => {
    void refresh()
    const onFocus = () => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  useEffect(() => {
    if (!data) return
    // This is a refresh hint; the server still decides eligibility using the displayed quest day.
    const timer = window.setTimeout(
      () => {
        void refresh()
      },
      Math.max(0, refreshAt.current - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [data, refresh])

  async function claim(id: DailyQuest['id']) {
    if (working.current || !data || loadError) return
    if (Date.now() >= refreshAt.current) {
      await refresh()
      return
    }
    if (data.quests.find((quest) => quest.id === id)?.rewardStatus !== 'available') return
    working.current = true
    setBusy(true)
    setMessage(null)
    try {
      const response = await client[':id'].claim.$post({
        param: { id },
        json: { day: data.day },
      })
      setMessage(
        response.ok
          ? { text: 'Demande de récompense acceptée.', error: false }
          : { text: await errorText(response), error: true },
      )
    } catch {
      setMessage({
        text: 'Impossible de confirmer votre demande. Consultez l’état actualisé de la récompense avant de réessayer.',
        error: true,
      })
    } finally {
      // Only the subsequent GET can confirm whether an accepted reward has been delivered.
      await load()
      working.current = false
      setBusy(false)
    }
  }

  const stale = data !== undefined && Date.now() >= refreshAt.current
  return (
    <section lang="fr" aria-labelledby="quests-title">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 id="quests-title">
          <Entity kind="quests" showLabel />
        </h1>
        <span className="status" data-status={status} role="status">
          {CONNECTION_LABELS[status]}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setMessage(null)
            void refresh()
          }}
        >
          Actualiser
        </button>
      </div>
      {data && (
        <p className="muted">
          Date : <time dateTime={data.day}>{data.day}</time> (UTC). Réinitialisation à 00 h 00 UTC.
        </p>
      )}
      {busy && <p role="status">{data ? 'Mise à jour des quêtes…' : 'Chargement des quêtes…'}</p>}
      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {message && (
        <p className={message.error ? 'error' : 'muted'} role={message.error ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      {stale && !busy && (
        <p role="status">
          La journée UTC a peut-être changé. Actualisez les quêtes avant de réclamer une récompense.
        </p>
      )}
      <div aria-busy={busy}>
        {data?.quests.map((quest) => (
          <QuestCard
            key={questInstanceId(data.day, quest.id)}
            quest={quest}
            disabled={busy || Boolean(loadError) || stale}
            onClaim={claim}
          />
        ))}
      </div>
    </section>
  )
}
