# Bilan technique de Royaumes

- Date : 2026-10-31
- Version examinée : `3efddd5`, avant la rédaction de ce bilan.
- Référence historique : `td11-fin`, commit `b681e18`.
- Auteur : Tiffany DBEISSY

Ce bilan dresse l'état technique du projet au terme de son développement, à partir de ses
décisions d'architecture, de ses indicateurs de qualité, de sa dette technique et de ses
revues. Il s'adresse à la personne qui reprendrait le projet.

Le périmètre couvre TD1–TD11 et Quests, en distinguant mesures locales, constats antérieurs
et contrôles restant à faire. L'organisation détaillée figure dans [l'architecture](architecture.md).

## 1. Le système livré

| Élément | Valeur |
| --- | --- |
| Modules métier | 6, plus le module technique `system` |
| Briques de la plateforme | 9 : authentification, HTTP, base, journal, projections, boîte d'envoi, temps réel, données personnelles, tâches quotidiennes |
| Lignes de code, hors tests | 7 240, sur 145 fichiers source |
| Fichiers de test, nombre de tests | 43 fichiers, 445 tests réussis |
| Commits | 100 accessibles depuis `3efddd5`, dont 23 depuis `td11-fin` |
| Hébergement | Vercel (Francfort), base Neon (Francfort) : configuration du monolithe |

| Module | Stockage | Lignes, hors tests |
| --- | --- | --- |
| `realm` | Event Sourcing | 791 |
| `dungeon` | Event Sourcing, projection des expéditions ouvertes | 1 614 |
| `market` | Event Sourcing, projection des offres, saga | 1 001 |
| `ranking` | Projection du journal | 333 |
| `tavern` | Tables ordinaires | 471 |
| `quests` | Projection de progression, événements de réclamation et de confirmation | 1 182 |
| `system` | Aucun | 43 |

Le périmètre de comptage est donné par `git ls-files -- src app scripts`, limité aux `.ts`
et `.tsx`, hors `*.test.ts` et `*.test.tsx`. Avec TypeScript 6.0.3, l'arbre syntaxique de chaque
fichier est parcouru par `getChildren()` : les lignes non vides occupées par les feuilles
sont comptées une fois, hors JSDoc et fin de fichier. Les commentaires seuls sont ainsi exclus.
Les valeurs par module couvrent son seul répertoire ; le total inclut aussi plateforme,
composition, pages, interface partagée et scripts. Les commits sont dénombrés par
`git rev-list --count 3efddd5` et `git rev-list --count td11-fin..3efddd5`.

Royaumes est un monolithe modulaire Next.js/Hono. Les domaines restent indépendants des
technologies ; la composition assemble leurs adaptateurs. Le Village gère les ressources,
le Donjon les expéditions et l'IA, le Marché les échanges, le Classement leurs résultats,
la Taverne les messages et la présence, et Quests les objectifs quotidiens et récompenses.

La configuration de production vise Vercel et Neon à Francfort, avec le Village dans
l'application. Le service Village autonome est un prototype exécutable et testé, non déployé.
PGlite fournit PostgreSQL en local et dans les tests ; ces résultats ne valident pas à eux
seuls le comportement du déploiement Neon/Vercel.

## 2. Les décisions d'architecture

| ADR | Décision | Mise à l'épreuve | Bilan |
| --- | --- | --- | --- |
| 0001 | Monolithe modulaire | Extraction du Village (TD11) ; règles d'importation | Entrées publiques et composition préservent les frontières sans imposer plusieurs services ([ADR](adr/0001-monolithe-modulaire.md)). |
| 0002 | Event Sourcing pour le Village | Tests du domaine, du journal et de concurrence | Décisions pures et historique rejouable ; coût de relecture et gestion des versions à maîtriser ([ADR](adr/0002-event-sourcing-village.md)). |
| 0003 | Server-Sent Events alimentés par le journal | Tests d'autorisation, de filtrage et de reconnexion | Actualisation sans calcul métier client ; lectures périodiques par abonné et notifications non garanties sans perte ([ADR](adr/0003-server-sent-events.md)). |
| 0004 | Manches simultanées et échéances paresseuses | Tests des règles et vues du Donjon avec horloge contrôlée | Pas de tâche permanente ; une échéance dépassée n'est enregistrée qu'à la commande suivante ([ADR](adr/0004-manches-simultanees.md)). |
| 0005 | Intelligence artificielle déterministe | Tests du hasard, des compagnons et des simulations | Expéditions reproductibles et comportements testables ; l'équilibrage à quatre joueurs reste limité ([ADR](adr/0005-intelligence-artificielle.md)). |
| 0006 | CQRS et projections rattrapées à la lecture | Tests du checkpoint atomique, du rejeu, des versions et des annulations | Lectures incrémentales sans processus permanent ; retard, verrouillage et coût de reconstruction. Les positions ne garantissent pas l'ordre de validation des transactions ([ADR](adr/0006-cqrs-projections.md)). |
| 0007 | Saga orchestrée et boîte d'envoi | Tests d'échanges concurrents, de transferts idempotents et de reprises après panne | Événements et messages atomiques, sans transaction distribuée ; états intermédiaires et reprises bornées, sans délai garanti ([ADR](adr/0007-saga-boite-envoi.md)). |
| 0008 | Taverne sans Event Sourcing, réécriture ciblée du journal | Tests de rétention, d'export, d'effacement et d'isolation | Stockage proportionné au besoin et traitements propres à chaque module ; limites explicites à l'effacement des historiques conservés ([ADR](adr/0008-donnees-personnelles.md)). |
| 0009 | Extraction du Village, préparée mais non déployée | Six tests de contrat : requêtes, secret, relais, échanges, panne et données personnelles | Façade distante interchangeable ; migrations, pagination et reprise doivent être traitées avant production ([ADR](adr/0009-extraction-village.md)). |
| 0010 | Événements de récompense et projection de progression | Tests de claims, d'atomicité, de concurrence, de minuit UTC et de reconstruction | Progression dérivée, historique des récompenses autoritatif ; le rejeu ne redistribue rien. Contexte de participation et conservation supplémentaires ([ADR](adr/0010-daily-quests-persistence.md)). |
| 0011 | Contrats publiés, outbox et SSE privé Quests | Tests de confirmation exacte, de doublons et de filtrage SSE/API | Réutilisation de la plateforme ; acceptation distincte du versement, cohérence différée et notifications limitées ([ADR](adr/0011-daily-quests-communication.md)). |

Le [registre des ADR](adr/README.md) rassemble les décisions détaillées.

Quests réutilise ces mécanismes plutôt que de créer une nouvelle infrastructure.
La projection versionnée observe les contrats Village, Donjon et Marché, avec attribution
aux humains et à l'acheteur ayant réussi son paiement.
Le jour UTC est tiré du temps de jeu ; le changement de jour ne nécessite aucune remise à zéro.

La progression est dérivée ; les acceptations et confirmations font autorité dans le journal.
La décision finale vérifie l'expiration, même après un conflit, et fige la récompense avec
un identifiant de transfert stable. Acceptation et demande de dépôt sont atomiques ; le
versement reste distinct du `202 Accepted`. Les tests couvrent les doublons, les pannes et
le rejeu sans redistribution. Le canal privé ne transmet que des invalidations : l'API reste
la source de l'affichage. Cette extension confirme la réutilisabilité du socle, mais ajoute
du contexte de participation et des obligations de conservation.

## 3. La qualité

| Caractéristique | Indicateur | Valeur | Appréciation |
| --- | --- | --- | --- |
| Adéquation fonctionnelle | Tests réussis ; couverture des domaines | 445 tests réussis ; lignes des domaines couvertes de 99,60 à 100 % | Règles et cas limites éprouvés ; les interactions de navigateur restent à vérifier. |
| Efficacité des performances | Débit et p99 des lectures ; respect du budget | Archives TD11 « après » : 600–1 176 req/s, p99 de 26 à 54 ms, aucune erreur | Budget historique respecté sur cinq lectures ; aucune mesure actuelle de Quests ou de son export. |
| Fiabilité | Tests de concurrence, de reprise et d'idempotence ; messages abandonnés | Tests réussis ; nombre de lettres mortes en production non mesuré | Atomicité et doublons couverts ; livraison et reprise exhaustive restent soumises aux limites documentées. |
| Sécurité | Exigences des revues de sécurité | Cinq revues disponibles, dont 11 exigences Quests ; détail en section 5 | Non-conformités et risques acceptés à distinguer ; aucune nouvelle validation exhaustive de production. |
| Maintenabilité | Règles d'architecture ; fonctions d'aptitude ; couverture | 9 règles sans violation ; 2 tests structurels réussis ; 76,86 % des lignes couvertes | Frontières contrôlées, code historique conservé ; couverture partielle, notamment des interfaces. |
| Flexibilité | Extraction d'un module ; changement de base entre local et production | Six tests de contrat du Village extrait réussis ; tests exécutés sur PGlite | Extraction éprouvée sans déploiement ; le comportement sur Neon n'a pas été vérifié ici. |

Mesures locales du 31 octobre, avec Node.js 22.20.0, pnpm 10.34.7 et Vitest 5.0.4.
`pnpm verify` réussit sur l'état actuel : lint, typage, dépendances et tests.
`pnpm test:coverage` réussit également. Les commandes ont été lancées avec
`pnpm_config_verify_deps_before_run=false`, sans installation de dépendances.

La référence a été extraite par `git archive` dans un répertoire temporaire, sans changement
de branche ni modification des sources courantes. Elle réutilise les dépendances installées :
manifeste, verrou et configuration Vitest sont identiques. `pnpm test:coverage` et
`pnpm lint:archi` y réussissent ; son `pnpm verify` complet n'a pas été relancé.
Il s'agit de mesures actuelles sur l'instantané historique, pas de résultats archivés de TD11.

| Indicateur | `td11-fin` remesuré | État actuel |
| --- | --- | --- |
| Fichiers de tests réussis | 33 | 43 |
| Tests réussis | 232 | 445 |
| Règles dependency-cruiser | 8 | 9 |
| Violations de dépendances | 0 — 144 unités, 461 dépendances analysées | 0 — 164 unités, 563 dépendances analysées |
| Tests structurels d'architecture réussis | 2 | 2 |
| Couverture des instructions | 73,28 % | 75,37 % |
| Couverture des branches | 64,20 % | 69,67 % |
| Couverture des fonctions | 69,78 % | 71,09 % |
| Couverture des lignes | 74,88 % | 76,86 % |

Les 33 fichiers historiques sont inchangés ; les dix nouveaux fichiers Quests portent
l'augmentation à **213 tests supplémentaires**. Les règles existantes sont conservées ;
`quests-gameplay-contracts-only` ajoute l'obligation de passer par les contrats de jeu.
Les deux [tests structurels](../src/bootstrap/architecture.test.ts) vérifient les schémas
propriétaires et la présence des contributeurs de données personnelles. Ce dernier contrôle
ne prouve pas, à lui seul, l'exhaustivité des exports ou des effacements.

La [couverture V8](../vitest.config.ts) porte sur `src/**/*.ts` et `src/**/*.tsx`, hors tests,
pages `app/` et scripts. Le rapport HTML est régénérable dans `coverage/index.html`.
Le périmètre s'est agrandi : la hausse globale ne démontre pas une amélioration de chaque
fichier. Les lignes des domaines atteignent 100 % pour Village, Marché, Taverne et Quests,
99,60 % pour Donjon ; les branches du domaine Quests atteignent 98,03 %. Les tests sont
exécutés sous Node.js : le rendu HTML de Quests ne valide pas ses interactions de navigateur.

Les résultats [avant](../perf/avant.json) et [après](../perf/apres.json), déjà présents à
`td11-fin`, respectent le [budget enregistré](../perf/budget.json) sur cinq lectures :
20 connexions, p99 inférieur à 500 ms, aucune erreur. Ils n'ont pas été remesurés ici et ne
couvrent ni Quests ni son export ; aucune performance actuelle ou de production n'en est déduite.

## 4. La dette technique

| Indicateur | Valeur |
| --- | --- |
| Entrées consignées | 12 |
| Entrées remboursées, dont à l'échéance prévue | 7 ; les 7 sont déclarées remboursées au TD prévu dans le registre, sans réaudit historique du calendrier |
| Entrées ouvertes | 5 : DT-008 à DT-012 |

Analyse :

Les dettes remboursées du [registre](qualite/dette-technique.md) concernaient
notamment le joueur unique, le stockage en mémoire, les conflits non repris, les compteurs
d'authentification locaux, les lectures recalculées et l'absence d'outil pour les lettres mortes.
Ces statuts ne remplacent pas une vérification indépendante du respect du calendrier des TD.

DT-008 à DT-010 conditionnent une extraction en production : migrations propres, pagination
et reprise de la boîte d'envoi distante. DT-011 documente la gestion heuristique des trous :
une reconstruction locale ne récupère pas un événement jamais relayé. DT-012 concerne le
coût potentiel de l'export Quests sur l'historique global, sans régression mesurée.
Les deux dernières échéances sont des déclencheurs de réexamen. Les cinq dettes ouvertes
ont leurs commentaires `DETTE TECHNIQUE DT-XXX` correspondants dans le code.

## 5. Les revues

| Revue | Exigences | Conformes | Non conformes ou en risque accepté | Actions ouvertes |
| --- | --- | --- | --- | --- |
| Sécurité de l'authentification | 16 | 11 | 5 non conformes ; 0 risque accepté | Corriger le décompte de synthèse ; réexaminer limitation hors Vercel, secret/HTTPS, inscription, cookies et déconnexion. |
| Sécurité du Donjon | 14 | 12 | 0 non conforme ; 2 risques acceptés | Réexaminer la consultation par adresse et les métadonnées divulguées si les besoins de confidentialité changent. |
| Sécurité du Marché | 10 | 10 | 0 non conforme ; 0 risque accepté | Conserver les contrôles de concurrence et d'idempotence. |
| Sécurité de Quests | 11 | 10 | 0 non conforme ; 1 risque accepté | Revoir conservation et purge ; effectuer les contrôles navigateur/production. |
| Conformité au RGPD | 10 | 4 | 6 non conformes ; 0 risque accepté | Actualiser les constats, compléter registre/export, réexaminer sessions expirées, journaux et exécution du cron. |

Sources : revues de [l'authentification](qualite/revue-securite-authentification.md),
du [Donjon](qualite/revue-securite-donjon.md), du [Marché](qualite/revue-securite-marche.md),
de [Quests](qualite/revue-securite-quests.md) et du [RGPD](rgpd/revue-conformite.md).
Le tableau compte leurs statuts versionnés ; ce n'est pas une nouvelle vérification
navigateur ou production de chacune de leurs exigences.

Trois écarts documentaires restent à traiter séparément : la synthèse d'authentification
annonce 9 conformités et 6 non-conformités, contrairement à ses lignes ; la revue RGPD
précède Quests et les ajouts récents au registre ; l'ADR-0007 annonce encore une garantie de
livraison et l'absence d'outil de lettres mortes. Aucun de ces documents n'a été réécrit ici.
Les actions anciennes restent à réévaluer, notamment sessions expirées, export complet,
journaux techniques et vérification des tâches de production.

## 6. Risques et recommandations

| N° | Risque | Signe avant-coureur | Recommandation |
| --- | --- | --- | --- |
| 1 | Progression retardée, notification manquée ou récompense en attente | Réponses `503 QUESTS_NOT_READY`, statut `pending` persistant, lettres mortes ou écart avec le journal | Diagnostiquer les curseurs et messages ; récupérer les événements absents avant reconstruction ; reprendre les livraisons selon les limites des ADR. Aucun délai de versement garanti. |
| 2 | Base applicative utilisée involontairement par le prototype Village | `VILLAGE_DATABASE_URL` absent et `DATABASE_URL` défini : `createDatabase()` choisit ce dernier | Clarifier ce choix avant exploitation du service autonome. Risque confirmé avec la fabrique isolée et des entrées/sorties simulées, sans connexion réelle ; non corrigé. |
| 3 | Conservation pseudonyme sans échéance ni critères de purge | Historiques et références toujours présents après suppression ; politique de durée non définie | Faire revoir justification et durées, compléter le responsable du traitement ; vérifier export, suppression et invalidation des sessions avec des comptes réels. L'acceptation architecturale ne démontre pas la conformité au RGPD. |
| 4 | Validation opérationnelle incomplète | Absence de vérification actuelle du déploiement Ready, des migrations, du cron et des parcours réels | Éprouver les modules, le règlement, les reconnexions SSE et les interfaces sur le déploiement cible ; vérifier aussi Mermaid sur GitHub. Ces contrôles n'ont pas été réalisés ici. |
| 5 | Limites de gameplay | Tous les bâtiments au niveau 10 rendent le Bâtisseur impossible les jours suivants ; expéditions à quatre faciles | Réexaminer les objectifs et l'équilibrage si les besoins évoluent ; ne pas confondre ces limites avec les dettes techniques. |

Le risque de configuration concerne le prototype extrait, non le Village intégré au monolithe.
Le retard de projection peut bloquer une réclamation près de minuit ; les contrôles locaux
ne garantissent ni une notification sans perte ni le règlement à une échéance donnée.

## 7. Conclusion

L'extension Quests s'appuie sur les frontières et mécanismes déjà éprouvés, avec davantage
de tests sans modification des fichiers de tests historiques. Le choix d'une solution adaptée
à chaque besoin — événements, projections ou tables ordinaires — évite une infrastructure
uniforme inutile. La contrepartie principale est l'exploitation de la cohérence différée :
reprise, supervision et confidentialité doivent rester explicites. La validation locale est
réussie ; les vérifications opérationnelles et les questions de conservation restent ouvertes.

## Usage de l'IA générative

Les ADR historiques déclarent, selon les décisions, aucune assistance ou l'aide d'un assistant,
notamment GitHub Copilot. Pour Quests, ChatGPT a soutenu les discussions d'architecture et
Codex a assisté l'implémentation, les tests et la documentation. Le porteur du projet a examiné
et approuvé progressivement les propositions et périmètres.

Ce bilan a été rédigé avec Codex à partir du code, des documents et des commandes exécutées.
Les chiffres sont issus des sorties locales et des rapports de couverture ; les références
et le diff ont été contrôlés. Aucune validation de navigateur ou de production n'est attribuée
à l'IA ou supposée réalisée.
