import { Hono } from 'hono'
import { createRealmModule } from '@/modules/realm'
import { VILLAGE_CHANNEL_PREFIX } from '@/modules/realm/contracts'
import type { Db } from '@/platform/db/client'
import { createEventStore } from '@/platform/event-store/event-store'
import { playerFromHeaders, requireServiceSecret } from '@/platform/http/service-auth'
import type { AppEnv } from '@/platform/http/types'
import { createInboxApi, forwardTo } from '@/platform/outbox/inbox-api'
import { createDispatcher } from '@/platform/outbox/outbox'
import { createPrivacyService } from '@/platform/privacy/privacy'

export interface VillageServiceDeps {
  /** Base du service : son propre journal et sa propre boîte d'envoi. */
  db: Db
  /** Secret partagé avec l'application. */
  secret: string
  /** Adresse de l'application, à laquelle le service transmet ses réponses. */
  appUrl: string
  /** Horloge de référence ; l'heure réelle par défaut. */
  clock?: () => number
  /** Fonction d'envoi des requêtes vers l'application ; remplacée dans les tests. */
  fetch?: typeof fetch
}

/**
 * Racine de composition du service Village extrait (TD11). Elle assemble le module Village,
 * inchangé, avec sa propre plateforme : journal, boîte d'envoi et droits des joueurs.
 * Toutes les routes exigent le secret partagé : seule l'application peut appeler le service.
 */
export function createVillageServiceApp({ db, secret, appUrl, clock, fetch }: VillageServiceDeps) {
  const store = createEventStore(db)
  const realm = createRealmModule({ store, clock })

  // Village messages are handled locally; other topics, including Market replies and
  // Quests delivery confirmations, are forwarded to the application.
  const dispatcher = createDispatcher(db)
  dispatcher.register(realm.handlers)
  dispatcher.registerFallback(forwardTo(`${appUrl}/api/internal`, secret, fetch))

  // Droits des joueurs : le service efface les données personnelles de son propre journal.
  const privacy = createPrivacyService(db, [realm.personalData], clock)

  return (
    new Hono<AppEnv>()
      .use(requireServiceSecret(secret))

      // API du Village, appelée par la passerelle de l'application au nom d'un joueur.
      .use('/realm/*', playerFromHeaders)
      .route('/realm', realm.api)

      // Incoming messages trigger dispatch of the replies produced by their handlers.
      // DETTE TECHNIQUE DT-010 (docs/qualite/dette-technique.md): without another incoming
      // message, failed Market replies or Quests confirmations have no dispatch trigger.
      .route(
        '/',
        createInboxApi(dispatcher, secret, () => dispatcher.dispatch()),
      )

      // Flux d'événements publié : les événements du Village postérieurs à une position.
      // DETTE TECHNIQUE DT-009 (docs/qualite/dette-technique.md): the entire event backlog
      // is returned in one response without pagination.
      .get('/events', async (c) => {
        const after = Number(c.req.query('after') ?? 0) || 0
        const events = await store.readAll({
          streamPrefix: VILLAGE_CHANNEL_PREFIX,
          afterPosition: after,
        })
        return c.json({ events })
      })

      // Droits des joueurs, demandés par l'application.
      .get('/personal-data/:playerId', async (c) => {
        const data = await privacy.exportData(c.req.param('playerId'))
        return c.json(data.sections.realm ?? null)
      })
      .delete('/personal-data/:playerId', async (c) =>
        c.json(await privacy.erase(c.req.param('playerId'))),
      )
  )
}
