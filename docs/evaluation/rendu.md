# Rendu de l'évaluation

- Auteur : Tiffany DBEISSY
- Module : Quêtes quotidiennes
- Adresse du déploiement : [royaumes-theta.vercel.app](https://royaumes-theta.vercel.app) — Royaumes est déployé sur Vercel ([dépôt](https://github.com/Tiffany-Dby/royaumes)).
- Fiche de cadrage : [fiche-cadrage.md](fiche-cadrage.md)
- Date : 2026-11-01
- Référence Git actuelle : `4da783c` (correctif E7) ; comparaison avec `td11-fin` (`b681e18`).
- Déploiement de production vérifié : `4da783c`, correctif E7 inclus.
- Statut : validations locales et en production terminées.

## Exigences minimales

| N° | Fichiers principaux | Tests qui la vérifient |
| --- | --- | --- |
| E1 | Couches domaine, application et infrastructure ; [api.ts](../../src/modules/quests/api.ts), [index.ts](../../src/modules/quests/index.ts), [contracts.ts](../../src/modules/quests/contracts.ts), [ui.tsx](../../src/modules/quests/ui.tsx). | Contrôles d'architecture en E9. |
| E2 | [create-api.ts](../../src/bootstrap/create-api.ts), [page Quests](../../app/(jeu)/quests/page.tsx), [navigation](../../src/ui/app-shell.tsx). | [ui.test.ts](../../src/modules/quests/ui.test.ts) couvre le rendu HTML. Accès à la page et fonctionnement validés par mes tests manuels en production. |
| E3 | [Catalogue](../../src/modules/quests/domain/catalog.ts), [jour UTC](../../src/modules/quests/domain/quest-day.ts), [progression](../../src/modules/quests/domain/progress.ts), [réclamation et statuts](../../src/modules/quests/domain/claim.ts). | [catalog.test.ts](../../src/modules/quests/domain/catalog.test.ts), [quest-day.test.ts](../../src/modules/quests/domain/quest-day.test.ts), [progress.test.ts](../../src/modules/quests/domain/progress.test.ts), [claim.test.ts](../../src/modules/quests/domain/claim.test.ts). |
| E4 | [Schéma](../../src/modules/quests/infrastructure/schema.ts), migrations [0013](../../drizzle/0013_quest-progress.sql), [0014](../../drizzle/0014_quest-dungeon-progress.sql), [0015](../../drizzle/0015_quest-market-progress.sql), [0016](../../drizzle/0016_quest-villages.sql), [repository](../../src/modules/quests/infrastructure/event-store-claim-repository.ts) ; [ADR-0010](../adr/0010-daily-quests-persistence.md). | [claim-persistence.test.ts](../../src/modules/quests/infrastructure/claim-persistence.test.ts) : atomicité et concurrence ; [progress-projection.test.ts](../../src/modules/quests/infrastructure/progress-projection.test.ts) : reconstruction et annulation sur erreur. |
| E5 | API et bootstrap : session obligatoire, identité du joueur et validation des entrées. | [quests-api.test.ts](../../src/bootstrap/quests-api.test.ts) : authentification, isolation, entrées invalides et vue périmée. |
| E6 | [Projection](../../src/modules/quests/infrastructure/progress-projection.ts), [service de réclamation](../../src/modules/quests/application/claim-service.ts), [confirmations](../../src/modules/quests/messages.ts) ; [ADR-0011](../adr/0011-daily-quests-communication.md). | Tests de projection, persistance et API : progression des participants, dépôts, confirmations et reprises. |
| E7 | [personal-data.ts](../../src/modules/quests/personal-data.ts), [registre T8](../rgpd/registre-traitements.md), [revue de sécurité](../qualite/revue-securite-quests.md). | [quests-privacy.test.ts](../../src/bootstrap/quests-privacy.test.ts) : export isolé, suppression et reconstruction ; [régression](../../src/bootstrap/quests-privacy.test.ts#L608) : export incomplet refusé, puis réussi après rattrapage. Export, suppression et invalidation de session validés en production. |
| E8 | Domaine et API ci-dessus ; correspondance BR-01–BR-12 en complément. | Validé : décisions métier BR-01–BR-12 couvertes par les tests du domaine ; GET `/api/quests` et POST `/api/quests/:id/claim` par les [tests API](../../src/bootstrap/quests-api.test.ts) ; SSE `/api/stream/quests` et son repli `/events` par les [tests temps réel](../../src/bootstrap/quests-realtime.test.ts). Les garanties de checkpoint, d'outbox et de concurrence sont testées en intégration. |
| E9 | [.dependency-cruiser.cjs](../../.dependency-cruiser.cjs), règles existantes conservées. | `pnpm lint:archi` et [architecture.test.ts](../../src/bootstrap/architecture.test.ts) réussissent. |
| E10 | [vercel.json](../../vercel.json), [migrate.ts](../../scripts/migrate.ts), [déploiement Vercel de `4da783c`](https://vercel.com/tiffany-dbys-projects/royaumes/4G9ChG8WNiGcNNHXyATB7jtQafRk). | Validé : version finale déployée et testée en production, correctif E7 inclus ; migrations appliquées. |

J'ai validé en production la version `4da783c` : Quêtes quotidiennes, progression,
versement des récompenses, export, suppression du compte et invalidation de session.
Les fonctionnalités existantes et les autres contrôles de production prévus sont également
vérifiés avec succès.

L'export JSON confirme le Bâtisseur à **2/2**, le Marchand à **1/1**, la récompense du
Bâtisseur de **50 bois** acceptée et versée, ainsi que l'existence du Village et
l'historique Quests.

Le précédent déploiement `8268285`, le 31 octobre, avait validé 445 tests sans violation
d'architecture, les migrations (« Migrations appliquées. ») et le build.

## Bonus revendiqués

Je revendique **B1, B2, B4, B6 et B8, soit +5 sous conditions** : validation de toutes les
exigences minimales, réussite de `pnpm verify` et preuves d'implémentation, de tests et de
documentation pour chaque bonus.

| N° | Description | Fichiers | Tests | Documentation |
| --- | --- | --- | --- | --- |
| B1 | Canal SSE privé (+1) | [quests-channel.ts](../../src/modules/quests/infrastructure/quests-channel.ts) | [quests-realtime.test.ts](../../src/bootstrap/quests-realtime.test.ts) : accès, filtrage et données neutralisées. | [README](../../README.md#temps-réel), [architecture](../architecture.md#quêtes-quotidiennes--communication-et-règlement-des-récompenses), [ADR-0011](../adr/0011-daily-quests-communication.md). |
| B2 | Échéance UTC sans tâche de remise à zéro (+1) | Jour UTC et décision de réclamation (E3). | Tests UTC, réclamation et changement de jour. | [README](../../README.md#quêtes-quotidiennes), [ADR-0010](../adr/0010-daily-quests-persistence.md). |
| B4 | Projection versionnée avec checkpoint et reconstruction (+1) | `quests-progress`, version 4 (E6). | Tests de projection (E4). | [Architecture](../architecture.md), ADR-0010. |
| B6 | Intégration avec Village, Donjon et Marché (+1) | Projection et dépôt de récompenses (E6). | Progression, [API](../../src/bootstrap/quests-api.test.ts#L306) et persistance. | [README](../../README.md#échanges-entre-modules), architecture, ADR-0011. |
| B8 | Nouvelle règle d'architecture (+1) | `quests-gameplay-contracts-only` (E9). | `pnpm lint:archi` ; essais négatifs runtime/type-only décrits dans ADR-0011. | [Architecture](../architecture.md#niveau-3---composants-de-lapplication-serveur), ADR-0011. |

Les deux nouvelles ADR sont acceptées et inscrites au [registre des décisions](../adr/README.md).

## Écarts avec la fiche de cadrage

- **Statut des récompenses :** prévu dans une projection, il est finalement calculé depuis
  les événements d'acceptation et de confirmation, avec l'éligibilité projetée. Cela garde
  l'historique comme référence sans ajouter une table de statut (ADR-0010).
- **Suppression du compte :** le cadrage parlait de données « effacées ou anonymisées ».
  L'identité et les sessions sont supprimées, les noms neutralisés, mais les références
  Quests et l'historique restent pseudonymes pour le rejeu et le règlement des récompenses.
  Cet historique n'est pas effacé physiquement ; sa durée de conservation et ses critères
  de purge restent à définir.
- **Précisions fonctionnelles :** `village_required` explicite BR-09. Les statuts `pending`
  et `delivered` suivent l'historique ; le serveur vérifie le jour affiché et l'éligibilité.
  Le `202` confirme l'acceptation, et la récompense reste due après minuit.

Les [limites actuelles](../../README.md#limites-actuelles) sont connues : Bâtisseur impossible
les jours suivants quand tous les bâtiments sont au niveau 10, retards de projection, notifications
SSE pouvant manquer et versements sans délai garanti. Le [registre de dette](../qualite/dette-technique.md)
détaille DT-011 (reprise du journal) et DT-012 (coût de l'export global). DT-008 à DT-010 et
le repli de `VILLAGE_DATABASE_URL` vers `DATABASE_URL` concernent le prototype Village extrait,
qui reste distinct du Village intégré à l'application déployée.

## Indicateurs au rendu

Résultats locaux du 1er novembre pour le code du commit `4da783c`, détaillés dans le
[bilan technique](../bilan-technique.md). `pnpm verify` et `pnpm build` réussissent ;
J'ai relancé `pnpm test:coverage`, dont le rapport HTML fournit la couverture.
Les mesures initiales du 31 octobre portaient sur `3efddd5`, au code identique à `8268285`.
Pour `td11-fin` (`b681e18`), les tests avec couverture et le contrôle de dépendances ont été
relancés le 31 octobre dans un répertoire séparé, avec les mêmes dépendances et la même
configuration Vitest.

| Indicateur | À l'étiquette td11-fin | Au rendu |
| --- | --- | --- |
| Nombre de tests | 232 réussis | 446 réussis |
| Couverture des lignes | 74,88 % | 76,9 % |
| Violations des règles d'architecture | 0 | 0 |

Le projet passe de **33 à 43 fichiers de tests** et de **8 à 9 règles de dépendances** ;
les deux tests structurels réussissent dans les deux versions. Les 33 fichiers historiques
sont inchangés ; **214 tests supplémentaires** ont été ajoutés. Autres couvertures :
instructions 73,28 → 75,4 %, branches 64,20 → 69,73 %, fonctions 69,78 → 71,09 %.

La [mesure V8](../../vitest.config.ts) couvre `src/**/*.ts` et `src/**/*.tsx`, hors tests ;
elle n'inclut ni les pages `app/` ni les scripts.

Le test de régression du correctif E7 vérifie qu'un rattrapage Quests incomplet provoque
l'erreur standard `500 INTERNAL`, sans fichier joint, puis qu'un nouvel export réussit
après rattrapage.

## Usage de l'IA générative

J'ai utilisé ChatGPT pour discuter les choix d'architecture et Codex pour m'aider à
implémenter le module, écrire les tests et préparer la documentation. J'ai relu les
propositions et les modifications avant mes commits, en avançant par périmètres validés.
Les résultats présentés viennent des contrôles automatisés et de mes vérifications manuelles
en production, détaillés dans le bilan.
Les ADR historiques précisent les autres contributions, notamment celles de GitHub Copilot.

## Compléments

### Traçabilité BR-01–BR-12

Les tests purs couvrent les décisions métier ; les tests d'intégration vérifient leur
application avec la base, les événements et la boîte d'envoi.

| Règle | Décision pure et preuve | Garantie complémentaire, hors domaine pur |
| --- | --- | --- |
| BR-01 — Quêtes communes | `catalog.test.ts` : trois objectifs, seuils et récompenses fixes. | GET renvoie les trois définitions. |
| BR-02 — Jour UTC | `quest-day.test.ts` : minuit, fuseaux, mois et année. | [API](../../src/bootstrap/quests-api.test.ts#L364) : nouveau jour, historique conservé. |
| BR-03 — Éligibilité des événements | `progress.test.ts` : jour de l'activité. | [Temps de jeu](../../src/modules/quests/infrastructure/progress-projection.test.ts#L82) et [comptage unique](../../src/modules/quests/infrastructure/progress-projection.test.ts#L134) via checkpoint. |
| BR-04 — Bâtisseur | Progression et catalogue : deux améliorations, 50 bois. | [Projection Builder](../../src/modules/quests/infrastructure/progress-projection.test.ts#L62) : cumul et plafond. |
| BR-05 — Aventurier | Progression : humains sans compagnons IA, victoire/défaite ; catalogue : 75 pierre. | [Projection Dungeon](../../src/modules/quests/infrastructure/progress-projection.test.ts#L667) : participation au passage de minuit. |
| BR-06 — Marchand | Progression : vendeur et acheteur réussi après refus ; catalogue : 100 or. | [Projection Market](../../src/modules/quests/infrastructure/progress-projection.test.ts#L366) : contexte et crédits. |
| BR-07 — Achèvement | Progression et claim : seuil, plafond et statuts. | Plafonnement SQL testé dans la projection. |
| BR-08 — Réclamation manuelle | Claim : expiration UTC. | [POST explicite](../../src/bootstrap/quests-api.test.ts#L79) ; [rejeu sans dépôt supplémentaire](../../src/modules/quests/infrastructure/claim-persistence.test.ts#L276). |
| BR-09 — Conditions | Claim : Village, progression, date, claim déjà accepté. | [Expiration après rattrapage ou conflit](../../src/modules/quests/infrastructure/claim-persistence.test.ts#L188). |
| BR-10 — Distribution | Catalogue et claim : récompense à verser. | [Dépôt avec replyTo](../../src/modules/quests/infrastructure/claim-persistence.test.ts#L69) et [atomicité outbox](../../src/modules/quests/infrastructure/claim-persistence.test.ts#L158). |
| BR-11 — Idempotence | Claim et [domaine Village](../../src/modules/realm/domain/transfers.test.ts#L70) : répétitions. | Réclamations et confirmations concurrentes testées. |
| BR-12 — Règlement | Claim : récompense acceptée conservée après minuit, statuts pending/delivered. | [Panne et reprise](../../src/bootstrap/quests-api.test.ts#L196), confirmation persistée. |
