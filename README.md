# Royaumes

Jeu web multijoueur servant de support au module Architecture et pilotage technique.
Le projet est organisé en monolithe modulaire : une application Next.js unique, découpée
en une plateforme technique et en modules métier aux frontières vérifiées automatiquement.

## Prérequis

- Node.js 22 ou supérieur
- pnpm 10

## Démarrage

```bash
pnpm install
pnpm dev
```

L'application est disponible à l'adresse http://localhost:3000.

## Comptes et configuration

L'espace de jeu est réservé aux joueurs connectés. Créez un compte depuis la page
http://localhost:3000/login.

Les variables d'environnement sont documentées dans le fichier `.env.example`. En local,
aucune n'est obligatoire. Pour définir vos propres valeurs, copiez ce fichier en
`.env.local`, qui n'est jamais versionné.

## Commandes

| Commande | Rôle |
| --- | --- |
| `pnpm dev` | Serveur de développement |
| `pnpm build` | Construction de la version de production |
| `pnpm start` | Serveur de production (après `pnpm build`) |
| `pnpm lint` | Formatage et analyse statique (Biome), sans modification |
| `pnpm lint:fix` | Application des corrections automatiques de Biome |
| `pnpm lint:archi` | Vérification des règles d'architecture (dependency-cruiser) |
| `pnpm typecheck` | Vérification des types (TypeScript) |
| `pnpm test` | Exécution des tests (Vitest) |
| `pnpm test:coverage` | Exécution des tests et mesure de la couverture (rapport dans `coverage/`) |
| `pnpm verify` | Ensemble des contrôles, à exécuter avant toute publication |
| `pnpm db:generate --name <nom>` | Production d'une migration après la modification d'un fichier `schema.ts` |
| `pnpm exec tsx scripts/simulate-dungeon.ts` | Mesure de l'équilibre du Donjon par la simulation d'expéditions |
| `pnpm db:migrate` | Application des migrations à la base désignée par `DATABASE_URL_UNPOOLED` ou `DATABASE_URL` |
| `pnpm vercel-build` | Construction exécutée par Vercel : contrôles, migrations, puis construction |
| `pnpm exec tsx scripts/load-test.ts <étiquette>` | Test de charge, application de production démarrée ; résultats dans `perf/<étiquette>.json` |
| `pnpm exec tsx scripts/dead-letters.ts` | Liste des messages abandonnés de la boîte d'envoi ; `retry <id>` en relance un |
| `SERVICE_SECRET=<secret> pnpm exec tsx scripts/village-service.ts` | Démarrage du service Village extrait, sur le port 4000 |

## Architecture

```
app/                  Pages et route unique de l'API (Next.js)
src/
  platform/           Plateforme technique, générique
  modules/            Modules métier, un répertoire par contexte délimité
  bootstrap/          Racine de composition de l'application
  services/           Racines de composition des services extraits
  ui/                 Thème et composants d'interface partagés
scripts/              Scripts d'exploitation, de mesure et de démarrage du service extrait
drizzle/              Migrations de la base de données
perf/                 Budget de performance et résultats des tests de charge
docs/
  adr/                Décisions d'architecture
  qualite/            Dette technique et revues
  rgpd/               Registre des traitements et revue de conformité
  architecture.md     Description de l'architecture (modèle C4)
  bilan-technique.md  Bilan technique du projet
```

Un module n'est accessible depuis l'extérieur que par ses entrées publiques : `index.ts`
(serveur), `contracts.ts` (types partagés) et `ui.tsx` (interface).

| Module | Rôle | Adresse de l'API |
| --- | --- | --- |
| `system` | Route de santé | `/api/system` |
| `realm` | Village : fondation, production de ressources, amélioration des bâtiments | `/api/realm` |
| `dungeon` | Donjon : expéditions de un à quatre héros, compagnons pilotés par l'ordinateur, deux niveaux de difficulté, combats en manches simultanées | `/api/dungeon` |
| `ranking` | Classement des joueurs, construit à partir des événements du Village et du Donjon | `/api/ranking` |
| `market` | Marché : échanges de ressources entre joueurs, par une saga orchestrée | `/api/market` |
| `tavern` | Taverne : salon de discussion commun et présence des joueurs, sans Event Sourcing | `/api/tavern` |
| `quests` | Quêtes quotidiennes : progression et récompenses individuelles | `GET /api/quests`, `POST /api/quests/:id/claim` |

### Quêtes quotidiennes

La page `/quests`, accessible depuis la navigation, propose trois quêtes communes à tous :
le Bâtisseur (deux améliorations de bâtiments, **50 bois**), l’Aventurier (une expédition
terminée, gagnée ou perdue, **75 pierre**) et le Marchand (un échange réussi, comme vendeur
ou acheteur, **100 or**). Seuls les participants humains sont crédités au Donjon.

La progression repart de zéro à **minuit UTC**, sans tâche planifiée. Les récompenses se
réclament manuellement avant la fin de la journée et nécessitent un Village.
Les deux routes exigent une session : `GET /api/quests` renvoie les quêtes, la progression
et les statuts du joueur ; `POST /api/quests/:id/claim` réclame une récompense avec le champ
JSON `day` du `GET`, pour éviter une réclamation depuis une vue périmée.

## Temps réel

Les changements sont diffusés aux navigateurs par des Server-Sent Events, à l'adresse
`/api/stream/<canal>`. Chaque canal n'est accessible qu'aux joueurs connectés autorisés par
la règle du module concerné. Le canal `village-<joueur>` n'est ainsi accessible qu'au
propriétaire du village, et le canal `dungeon-<expédition>` aux seuls membres de l'expédition.

La plupart des canaux correspondent à un flux du journal d'événements. Les canaux `ranking`
et `market` sont des canaux globaux : ils suivent, dans tout le journal, les événements qui
modifient le classement ou la liste des offres, et ne transmettent que ceux qui sont
enregistrés après leur ouverture.

Le canal `tavern` ne lit pas le journal, mais la table des messages de la Taverne : il
transmet chaque nouveau message, avec son contenu, à tous les joueurs connectés.

Les canaux du Donjon, du Classement et du Marché sont discrets : ils ne transmettent que la position,
le flux, le type et la version des événements, et chaque navigateur relit sa propre vue, filtrée
par le serveur.

Le canal privé `quests` (`/api/stream/quests`) n'annonce que les changements du joueur
connecté, sans données de jeu. La page actualise sa vue par `GET /api/quests`, également
à la reconnexion, au retour du focus et à minuit UTC.

Un flux se ferme de lui-même au bout de 240 secondes, et le navigateur tente de s'y
reconnecter automatiquement avec un identifiant de reprise. En développement, la variable
`STREAM_MAX_SECONDS` permet de raccourcir cette durée pour observer la reconnexion.

## Échanges entre modules

Les échanges du Marché utilisent une saga orchestrée (ADR 0007) : chaque étape est une
transaction locale à un module. Les modules communiquent par des messages enregistrés
dans la boîte d'envoi (`platform.outbox`), dans la même transaction que leurs événements.
La distribution est déclenchée après les commandes et à la consultation de la liste du
Marché, ainsi que chaque jour par la tâche planifiée `/api/cron/daily`.
Un message peut être remis plusieurs fois : les gestionnaires sont donc idempotents.
Les reprises dépendent de nouveaux appels au distributeur, sans garantie de livraison.
Après dix tentatives sans traitement confirmé, le message reste en lettre morte : la tâche
quotidienne le signale, et `scripts/dead-letters.ts` permet de l'examiner puis de le remettre
en attente, une fois sa cause corrigée.

Les Quêtes calculent la progression depuis les événements publiés du Village, du Donjon et
du Marché. Une réclamation acceptée enregistre atomiquement la récompense et son message de
dépôt au Village. Le **`202 Accepted` confirme l'acceptation, pas le versement** : le statut
reste `pending` tant qu'aucune confirmation du Village n'est enregistrée, puis devient
`delivered`. Le versement est asynchrone ; une récompense acceptée reste due après minuit
([ADR 0011](docs/adr/0011-daily-quests-communication.md)).

## Service Village extrait

Le module Village peut s'exécuter dans un service autonome, avec sa propre base (ADR 0009).
Cette configuration sert à vérifier les frontières du module ; elle n'est pas déployée. En
local, démarrez le service, puis l'application, dans deux terminaux, avec le même secret :

```bash
SERVICE_SECRET=<secret> pnpm exec tsx scripts/village-service.ts
REALM_SERVICE_URL=http://localhost:4000 SERVICE_SECRET=<secret> pnpm dev
```

Le service conserve ses données dans `.data/village`. Sans ces deux variables, le Village
s'exécute dans l'application, comme en production.

## Données personnelles

Le jeu traite des données personnelles, recensées dans le
[registre des traitements](docs/rgpd/registre-traitements.md). Chaque joueur peut, depuis la
page « Mes données » :

- télécharger un export JSON de ses données (`GET /api/account/export`) ;
- supprimer son compte (`DELETE /api/account`) : l'identité et les sessions sont supprimées,
  chaque module applique sa politique d'effacement, et les noms concernés sont remplacés
  par une mention neutre dans le journal (ADR 0008). Chaque effacement est consigné dans
  `platform.erasures`.

L'export inclut la progression, les participations, l'existence du Village et les récompenses
du joueur dans les Quêtes. Si leur projection n'est pas encore rattrapée, l'export est refusé
plutôt que renvoyé incomplet ; il peut être redemandé après rattrapage.
Après suppression du compte, ces données sans noms sont conservées
sous forme pseudonyme pour le rejeu et le règlement des récompenses
([ADR 0010](docs/adr/0010-daily-quests-persistence.md)).

Les messages de la Taverne sont conservés trente jours, et la présence d'un joueur deux
minutes après son dernier signal. Ces durées sont appliquées à chaque lecture, et chaque jour
par la tâche planifiée `/api/cron/daily`.

## Base de données

En développement, la base PostgreSQL est fournie par PGlite et conservée dans le répertoire
`.data/`, exclu du dépôt. Les migrations du répertoire `drizzle/` y sont appliquées au
démarrage. Pour repartir d'une base vide, arrêtez le serveur et supprimez le répertoire `.data/`.

Les tests utilisent une base PGlite en mémoire, recréée pour chaque fichier de test.

Le classement, la liste des expéditions ouvertes et la progression des Quêtes sont des
modèles de lecture, tenus à jour par des projections du journal (ADR 0006). Chaque projection
est rattrapée à la consultation, et reconstruite lorsque sa version augmente : une modification
qui change le contenu de ses tables doit donc augmenter sa version.

Le schéma `quests` contient la progression reconstruisible ; l'historique des réclamations
et des confirmations fait autorité dans le journal (`platform.events`, ADR 0010).

En production, la base est hébergée par Neon. Les migrations y sont appliquées lors de
chaque déploiement, après les contrôles et avant la construction de l'application.

## Performance

Le script `scripts/load-test.ts` mesure le débit et les latences des principales lectures,
sous une charge de vingt connexions simultanées, et confronte les résultats au budget de
performance de `perf/budget.json` : 99 % des lectures servies en moins de 500 ms, sans
erreur. Il est exécuté sur la construction de production, base recréée, avec
`AUTH_RATE_LIMIT=off`, avant chaque publication qui touche aux performances.

## Déploiement

L'application est déployée sur Vercel, dans la région de Francfort ; son adresse est
indiquée dans la rubrique « About » du dépôt GitHub. Chaque envoi sur la branche `main`
déclenche un déploiement, qui n'aboutit que si `pnpm verify` réussit.

Les variables `DATABASE_URL` et `DATABASE_URL_UNPOOLED` sont fournies par l'intégration
Neon de Vercel. Les variables `BETTER_AUTH_SECRET` et `CRON_SECRET` sont définies dans les
réglages du projet Vercel ; elles ne sont jamais versionnées. L'application refuse de démarrer
sans la première ; sans la seconde, la route des tâches quotidiennes reste fermée.

## Documentation

- [Architecture](docs/architecture.md)
- [Décisions d'architecture](docs/adr/README.md)
- [ADR 0010 — Persistance des Quêtes quotidiennes](docs/adr/0010-daily-quests-persistence.md)
- [ADR 0011 — Communication et temps réel des Quêtes](docs/adr/0011-daily-quests-communication.md)
- [Fiche de cadrage des Quêtes quotidiennes](docs/evaluation/fiche-cadrage.md)
- [Rendu de l'évaluation finale](docs/evaluation/rendu.md)
- [Registre de la dette technique](docs/qualite/dette-technique.md)
- [Revue de sécurité de l'authentification](docs/qualite/revue-securite-authentification.md)
- [Revue de sécurité du Donjon](docs/qualite/revue-securite-donjon.md)
- [Revue de sécurité du Marché](docs/qualite/revue-securite-marche.md)
- [Registre des traitements](docs/rgpd/registre-traitements.md)
- [Revue de conformité au RGPD](docs/rgpd/revue-conformite.md)
- [Bilan technique](docs/bilan-technique.md)

## Conventions

- Messages de commit conformes à Conventional Commits.
- `pnpm verify` doit réussir avant tout envoi sur la branche `main`.

## Limites actuelles

Par défaut, chaque flux temps réel interroge sa source deux fois par seconde : la charge de
la base croît avec le nombre de joueurs connectés. Ce compromis, acceptable pour le nombre
de joueurs du projet, est décrit dans l'ADR 0003. La reprise SSE ne garantit pas l'absence
de pertes ; les Quêtes relisent leur API pour actualiser la vue.

Le Bâtisseur ne peut plus être terminé les jours suivants lorsque tous les bâtiments ont
atteint le niveau 10. Le versement des récompenses n'a pas de délai garanti ; une lettre
morte peut nécessiter une intervention.

Une échéance du Donjon, de manche ou d'exploration, n'est enregistrée qu'à la commande
suivante d'un membre de l'expédition ; toute lecture l'affiche néanmoins comme passée
(ADR 0004). Les expéditions de quatre joueurs restent faciles, même au niveau difficile :
le script de simulation permet de le mesurer.

Le classement, la liste des expéditions ouvertes et les Quêtes peuvent présenter, pendant quelques
secondes, un état qui ne tient pas encore compte des derniers événements. La reconstruction
d'une projection a lieu pendant une consultation : sa durée croît avec la taille du journal
(ADR 0006). Les Quêtes peuvent temporairement refuser une lecture ou une réclamation si la
projection n'est pas rattrapée (`503 QUESTS_NOT_READY`).

Une offre échue n'est plus proposée ni acceptée, mais la restitution de ses ressources
passe par la boîte d'envoi, distribuée notamment à la consultation de la liste du Marché
ou par la tâche quotidienne ; cela ne garantit pas un délai de remboursement.

L'effacement d'un compte parcourt tout le journal d'événements : sa durée croît avec la taille
du journal. L'identifiant d'un joueur effacé reste dans le journal, sous une forme
pseudonyme, ainsi que les données Quests nécessaires au rejeu et au règlement ; il ne s'agit
pas d'une anonymisation complète ni d'un effacement physique de cet historique (ADR 0008).

Le service Village extrait n'est pas prêt pour la production : ses migrations, la pagination
de son flux publié et la distribution de sa boîte d'envoi restent à traiter. Ces limites du
service extrait sont recensées dans le registre de la dette technique.
