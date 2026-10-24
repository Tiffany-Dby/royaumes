import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DailyQuest, RewardStatus } from './contracts'
import { QUESTS } from './domain/catalog'
import { QuestCard, QuestsScreen } from './ui'

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return { ...actual, useState: vi.fn(actual.useState) }
})

afterEach(() => vi.mocked(React.useState).mockReset())

function card(status: RewardStatus, disabled = false) {
  const quest: DailyQuest = {
    ...QUESTS[0],
    progress: status === 'in_progress' ? 1 : 2,
    completed: status !== 'in_progress',
    rewardStatus: status,
  }
  return renderToStaticMarkup(
    React.createElement(QuestCard, { quest, disabled, onClaim: () => {} }),
  )
}

describe('Daily Quests rendered markup', () => {
  it('displays the objective, reward and labelled numeric progress', () => {
    const html = card('in_progress')
    expect(html).toContain('Le Bâtisseur')
    expect(html).toContain('Améliorer 2 bâtiments du Village.')
    expect(html).toContain('Récompense')
    expect(html).toContain('50 bois')
    expect(html).toContain('Progression')
    expect(html).toContain('1/2')
    expect(html).toContain('aria-label="Progression : Le Bâtisseur"')
    expect(html).toContain('value="1"')
    expect(html).toContain('max="2"')
    expect(html).toContain('aria-label="Récupérer la récompense : Le Bâtisseur"')
  })

  it.each([
    ['in_progress', 'En cours'],
    ['available', 'Récompense disponible'],
    ['village_required', 'Village requis'],
    ['pending', 'Versement en attente'],
    ['delivered', 'Récompense versée'],
  ] as const)('renders %s and enables only available rewards', (status, label) => {
    const html = card(status)
    expect(html).toContain(label)
    expect(html.includes('disabled=""')).toBe(status !== 'available')
  })

  it('renders an available reward disabled when the screen marks its data unsafe or busy', () => {
    expect(card('available', true)).toContain('disabled=""')
  })

  it('offers a Village link when claiming requires one', () => {
    const html = card('village_required')
    expect(html).toContain('href="/village"')
    expect(html).toContain('Fonder un village')
  })

  it('renders a French loading announcement before client effects run', () => {
    const html = renderToStaticMarkup(React.createElement(QuestsScreen))
    expect(html).toContain('lang="fr"')
    expect(html).toContain('Quêtes quotidiennes')
    expect(html).toContain('role="status"')
    expect(html).toContain('Chargement des quêtes…')
    expect(html).toContain('data-status="connecting"')
    expect(html).toContain('Connexion au temps réel…')
    expect(html).not.toContain('Actualiser')
    expect(html).not.toContain('Réessayer')
  })

  it.each([false, true])('offers retry only after loading fails and stops (busy: %s)', (busy) => {
    vi.mocked(React.useState)
      .mockReturnValueOnce([undefined, vi.fn()])
      .mockReturnValueOnce([busy, vi.fn()])
      .mockReturnValueOnce(['Impossible de charger les quêtes. Veuillez réessayer.', vi.fn()])
    const html = renderToStaticMarkup(React.createElement(QuestsScreen))
    expect(html).toContain('role="alert"')
    expect(html).toContain('Impossible de charger les quêtes.')
    expect(html.includes('>Réessayer</button>')).toBe(!busy)
    expect(html).not.toContain('Actualiser')
  })

  it.each([
    { quest: QUESTS[1], reward: '75 pierre' },
    { quest: QUESTS[2], reward: '100 or' },
  ])('renders the French reward label for $quest.id', ({ quest, reward }) => {
    const html = renderToStaticMarkup(
      React.createElement(QuestCard, {
        quest: { ...quest, progress: 0, completed: false, rewardStatus: 'in_progress' },
        disabled: false,
        onClaim: () => {},
      }),
    )
    expect(html).toContain(reward)
  })
})
