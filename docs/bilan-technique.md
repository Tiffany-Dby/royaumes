# Bilan technique de Royaumes

- Date : 2026-11-01
- Version examinée : étiquette `eval-fin` prévue, non créée ; commit déployé `4da783c` ; comparaison avec `td11-fin` (`b681e18`).
- Auteur : Tiffany DBEISSY

Ce bilan dresse l'état technique du projet au terme de son développement, à partir de ses
décisions d'architecture, de ses indicateurs de qualité, de sa dette technique et de ses
revues. Il s'adresse à la personne qui reprendrait le projet.

## 1. Le système livré

| Élément | Valeur |
| --- | --- |
| Modules métier | 6, plus le module technique `system` |
| Briques de la plateforme | 9 : authentification, HTTP, base, journal, projections, boîte d'envoi, temps réel, données personnelles, tâches quotidiennes |
| Lignes de code, hors tests | 7 244 sur 145 fichiers TS/TSX de `src app scripts`, hors commentaires |
| Fichiers de test, nombre de tests | 43 fichiers, 446 tests réussis |
| Commits | 105 à `4da783c`, dont 28 depuis `td11-fin` |
| Hébergement | Vercel (Francfort), base Neon (Francfort) |

| Module | Stockage | Lignes, hors tests |
| --- | --- | --- |
| `realm` | Event Sourcing | 791 |
| `dungeon` | Event Sourcing, projection des expéditions ouvertes | 1 614 |
| `market` | Event Sourcing, projection des offres, saga | 1 001 |
| `ranking` | Projection du journal | 333 |
| `tavern` | Tables ordinaires | 471 |
| `system` | Aucun | 43 |
| `quests` | Projection de progression, événements de réclamation et de confirmation | 1 186 |

## 2. Les décisions d'architecture

| ADR | Décision | Mise à l'épreuve | Bilan |
| --- | --- | --- | --- |
| 0001 | Monolithe modulaire | Extraction du Village (TD11) | Frontières maintenues sans imposer plusieurs services ([ADR](adr/0001-monolithe-modulaire.md)). |
| 0002 | Event Sourcing pour le Village | Tests du domaine, du journal et de concurrence | Décisions pures et historique rejouable ; coût de relecture ([ADR](adr/0002-event-sourcing-village.md)). |
| 0003 | Server-Sent Events alimentés par le journal | Tests d'accès, de filtrage et de reconnexion | Vue actualisée ; lectures par abonné et notifications pouvant manquer ([ADR](adr/0003-server-sent-events.md)). |
| 0004 | Manches simultanées et échéances paresseuses | Tests avec horloge contrôlée | Pas de tâche permanente ; expiration enregistrée à la commande suivante ([ADR](adr/0004-manches-simultanees.md)). |
| 0005 | Intelligence artificielle déterministe | Tests du hasard, des compagnons et simulations | Comportements reproductibles ; Donjon à quatre encore trop facile ([ADR](adr/0005-intelligence-artificielle.md)). |
| 0006 | CQRS et projections rattrapées à la lecture | Tests de checkpoint, version, rejeu et annulation | Lectures incrémentales ; coût de reconstruction et limites d'ordre du journal, DT-011 ([ADR](adr/0006-cqrs-projections.md)). |
| 0007 | Saga orchestrée et boîte d'envoi | Tests d'échanges concurrents, de doublons et de pannes | Atomicité locale et transferts idempotents ; états intermédiaires et reprises bornées ([ADR](adr/0007-saga-boite-envoi.md)). |
| 0008 | Taverne sans Event Sourcing, réécriture ciblée du journal | Tests de rétention, d'export et d'effacement | Stockage adapté ; noms neutralisés, mais références pseudonymes conservées ([ADR](adr/0008-donnees-personnelles.md)). |
| 0009 | Extraction du Village, préparée mais non déployée | Six tests de contrat | Prototype fonctionnel ; migrations, pagination et reprise à traiter avant production ([ADR](adr/0009-extraction-village.md)). |
| 0010 | Événements de récompense et projection de progression | Tests des réclamations, minuit UTC, concurrence et reconstruction | Récompenses figées, historique faisant autorité et rejeu sans redistribution ; conservation supplémentaire ([ADR](adr/0010-daily-quests-persistence.md)). |
| 0011 | Contrats publiés, outbox et SSE privé Quests | Tests API, confirmations et isolation SSE | Contrats respectés ; acceptation distincte du versement et cohérence différée ([ADR](adr/0011-daily-quests-communication.md)). |

## 3. La qualité

| Caractéristique | Indicateur | Valeur | Appréciation |
| --- | --- | --- | --- |
| Adéquation fonctionnelle | Tests réussis ; couverture des domaines | 232 → 446 tests, 33 → 43 fichiers depuis `td11-fin` ; domaines couverts de 99,60 à 100 % des lignes | 214 tests supplémentaires ; les 33 fichiers historiques sont inchangés. Parcours de production validés. |
| Efficacité des performances | Débit et p99 des lectures ; respect du budget | Archives TD11 : 600–1 176 req/s, p99 de 26 à 54 ms, 0 erreur | [Budget](../perf/budget.json) respecté sur cinq lectures ([mesures](../perf/apres.json)) ; Quests et son export non mesurés. |
| Fiabilité | Tests de concurrence, de reprise et d'idempotence ; messages abandonnés | Tests réussis ; nombre de lettres mortes en production non mesuré | Atomicité et doublons couverts ; reprises bornées et intervention parfois nécessaire. |
| Sécurité | Exigences des revues de sécurité | Cinq revues, dont 11 exigences Quests | Contrôles locaux et de production réalisés ; risques acceptés et non-conformités distingués en section 5. |
| Maintenabilité | Règles d'architecture ; fonctions d'aptitude ; couverture | Depuis `td11-fin` : 8 → 9 règles, 0 → 0 violation ; 2 tests structurels réussis dans les deux versions ; lignes 74,88 → 76,9 % | Frontières contrôlées ; couverture partielle des interfaces, dont les tests automatisés vérifient le rendu HTML. |
| Flexibilité | Extraction d'un module ; changement de base entre local et production | Six tests de contrat du Village extrait ; PGlite en test, Neon en production | Monolithe validé sur Neon ; service Village autonome testé localement, non déployé. |

## 4. La dette technique

| Indicateur | Valeur |
| --- | --- |
| Entrées consignées | 12 |
| Entrées remboursées, dont à l'échéance prévue | 7, déclarées remboursées au TD prévu dans le registre |
| Entrées ouvertes | 5 : DT-008 à DT-012 |

Analyse :

Le [registre](qualite/dette-technique.md) conserve les sept remboursements. DT-008 à DT-010
concernent seulement le prototype Village : migrations, pagination et reprise de l'outbox.
DT-011 décrit le franchissement heuristique des trous du journal : un événement absent du
journal local doit être récupéré avant reconstruction. DT-012 concerne le coût potentiel de
l'export Quests sur l'historique global, sans régression mesurée. Les échéances sont des
conditions de réexamen explicites ; les cinq dettes ouvertes ont leurs commentaires
`DETTE TECHNIQUE DT-XXX` dans le code.

## 5. Les revues

| Revue | Exigences | Conformes | Non conformes ou en risque accepté | Actions ouvertes |
| --- | --- | --- | --- | --- |
| Sécurité de l'authentification | 16 | 11 | 5 non conformes ; 0 risque accepté | [Revue](qualite/revue-securite-authentification.md) : limitation hors Vercel, secret/HTTPS, inscription, cookies et échec de déconnexion à revoir. |
| Sécurité du Donjon | 14 | 12 | 0 non conforme ; 2 risques acceptés | [Revue](qualite/revue-securite-donjon.md) : réexaminer consultation par adresse et métadonnées si les besoins de confidentialité changent. |
| Sécurité du Marché | 10 | 10 | 0 non conforme ; 0 risque accepté | [Revue](qualite/revue-securite-marche.md) : conserver les tests de concurrence et d'idempotence. |
| Conformité au RGPD | 10 | 4 | 6 non conformes ; 0 risque accepté | [Revue](rgpd/revue-conformite.md) : actualiser les constats après les contrôles de production ; compléter registre/export, durées, purge, sessions et journaux. |
| Sécurité de Quests | 11 | 10 | 0 non conforme ; 1 risque accepté | [Revue](qualite/revue-securite-quests.md) : définir conservation et purge ; conserver les tests de non-régression. |

## 6. Risques et recommandations

| N° | Risque | Signe avant-coureur | Recommandation |
| --- | --- | --- | --- |
| 1 | Progression retardée ou récompense bloquée | `503 QUESTS_NOT_READY`, statut `pending` persistant, lettres mortes ou écart avec le journal | Récupérer les événements absents avant rejeu ; diagnostiquer et relancer les lettres mortes. Aucun délai de versement garanti. |
| 2 | Conservation pseudonyme sans échéance | Historiques et références présents après suppression, sans critères de purge | Définir justification, durées et purge ; l'acceptation architecturale ne démontre pas la conformité au RGPD. |
| 3 | Configuration du prototype Village extrait | `VILLAGE_DATABASE_URL` absente et `DATABASE_URL` définie : repli vers la base applicative | Clarifier ou bloquer ce repli avant exploitation du service autonome. Ce risque confirmé ne concerne pas le Village intégré au monolithe déployé. |

## 7. Conclusion

Le projet peut être repris en conservant les domaines purs, les frontières vérifiées et les
tests de non-régression. Quests réutilise le journal, les projections et l'outbox ; la
contrepartie est une cohérence différée qui exige suivi des reprises et règles de conservation.
Le commit `4da783c` est déployé et validé en production, y compris le correctif E7,
la progression, le versement, l'export, la suppression du compte et l'invalidation de session.
Le Bâtisseur reste impossible lorsque tous les bâtiments sont au niveau 10 ; les autres
limites figurent dans le [README](../README.md#limites-actuelles).

Les mesures du 1er novembre confirment `pnpm verify`, `pnpm build` et la couverture V8 de
`src/`, hors tests : instructions 73,28 → 75,4 %, branches 64,20 → 69,73 %, fonctions
69,78 → 71,09 % depuis `td11-fin`. Cette version historique a été réexécutée le 31 octobre dans un
répertoire isolé, avec les mêmes dépendances et la même configuration Vitest ; le détail
figure dans le [rendu](evaluation/rendu.md). Les tailles portent sur `4da783c` : lignes non
vides des feuilles syntaxiques TypeScript, hors JSDoc et fin de fichier ; les commits sont
comptés par `git rev-list --count 4da783c` et `git rev-list --count td11-fin..4da783c`.
L'étiquette `eval-fin` reste à créer sur l'état final du dépôt.

## Usage de l'IA générative

ChatGPT a soutenu les choix d'architecture ; Codex a assisté le code, les tests et la
rédaction. Les ADR historiques précisent notamment l'aide de GitHub Copilot. La porteuse
du projet a relu les propositions et modifications avant ses commits. Les résultats ont
été vérifiés par lecture du code, tests automatisés, contrôle des références et du diff ;
les parcours de production ont été réalisés par Tiffany DBEISSY.
