# Revue de conformité au RGPD

- Date : 2026-10-20
- Mise à jour documentaire : 2026-10-31, avec Quests.
- Périmètre : données personnelles de l'ensemble du jeu, export et effacement, durées de conservation, journaux techniques.
- Références : RGPD, articles 5, 15, 17, 20, 25 et 30 ; [registre des traitements](registre-traitements.md) ; [ADR 0008](../adr/0008-donnees-personnelles.md) et [ADR 0010](../adr/0010-daily-quests-persistence.md).

La mise à jour repose sur la lecture du code et des assertions des tests existants.
Les essais et scans manuels du TD10 restent des constats historiques ; aucun nouveau
contrôle d'export ou d'effacement en production n'a été effectué.

| N° | Exigence | Vérification | Constat | Statut |
| --- | --- | --- | --- | --- |
| R1 | Chaque emplacement de données personnelles figure au registre des traitements | Comparaison du [registre](registre-traitements.md) avec les schémas, notamment [identity](../../src/platform/auth/schema.ts) et [quests](../../src/modules/quests/infrastructure/schema.ts) | T8 couvre désormais Quests et la date du registre est renseignée. Le responsable reste à compléter ; `identity.verification` et les compteurs par IP de `identity.rate_limit` n'y sont pas explicitement recensés. | non conforme |
| R2 | L'export contient toutes les données du joueur, module par module | [Test des sept contributeurs](../../src/bootstrap/quests-privacy.test.ts#L394) ; lecture des contributeurs Donjon, Quests et identité | L'export inclut `realm`, `dungeon`, `market`, `ranking`, `tavern`, `quests` et `identity`. Quests fournit progression, participations, existence du Village et récompenses. Les actions personnelles du Donjon et les messages de `platform.outbox` ne sont toujours pas exportés. | non conforme |
| R3 | L'export ne contient ni les données des autres joueurs, ni les secrets du jeu ou du compte | [Tests d'isolation généraux](../../src/bootstrap/privacy-api.test.ts#L71) et Quests : [participations](../../src/bootstrap/quests-privacy.test.ts#L181), [récompenses](../../src/bootstrap/quests-privacy.test.ts#L273) ; recherche historique de « password » et « token » dans un export | Les assertions excluent les données des autres joueurs et les graines des expéditions ; Quests omet les contreparties et les noms. L'identité n'exporte ni empreinte ni jeton. L'export manuel du TD10 ne contenait ni « password » ni « token ». | conforme |
| R4 | Après la suppression d'un compte, son nom et celui de son village n'apparaissent plus dans aucune table | Scan PGlite du TD10 ; [tests Quests d'effacement et de reconstruction](../../src/bootstrap/quests-privacy.test.ts#L434) | Le scan historique ne retrouvait ni « Zéphyrine » ni « Brumeval » dans les six schémas examinés, après deux réécritures. Quests ne copie pas de noms ; ses tests vérifient la neutralisation du nom du Village et la suppression de l'identité, mais conservent les références pseudonymes (R10). | conforme |
| R5 | L'effacement est tracé, sans conserver de donnée sur le joueur, et peut être relancé | Tests « enregistre l'effacement dans le registre... » et « peut être relancé sans effet supplémentaire » | Les tests vérifient que `platform.erasures` ne contient que l'identifiant auto-incrémenté, la date et le nombre d'événements réécrits, et qu'une seconde suppression renvoie zéro événement réécrit. L'effacement réel a renvoyé `eventsRewritten: 2`. | conforme |
| R6 | Les messages de la Taverne ne sont pas conservés plus de trente jours, même sans visite | [Test de purge sans visite](../../src/bootstrap/privacy-api.test.ts#L183) ; configuration `vercel.json` et tâche quotidienne | La suppression est testée localement et planifiée chaque jour à 04:00 UTC. L'exécution effective du cron en production reste à confirmer ; les journaux du build ne vérifient pas cette tâche. | non conforme |
| R7 | La présence ne constitue aucun historique des visites | Test « considère comme parti un joueur sans signal depuis deux minutes, et supprime sa ligne » | Le test passe. La table a une seule ligne par `playerId`, mise à jour au heartbeat ; départ explicite ou dernier signal de plus de deux minutes supprime la ligne, sans historique des visites. | conforme |
| R8 | Les sessions expirées ne sont pas conservées indéfiniment | Requête SQL sur `identity.session` : sessions dont `expires_at` est passé | La requête PGlite a renvoyé 0 session expirée à la date de la revue. Cependant, Better Auth ne supprime une session expirée qu'à l'occasion d'une requête qui la présente ; aucune purge planifiée des sessions orphelines n'est configurée. Une session abandonnée peut donc rester en base indéfiniment. | non conforme |
| R9 | Les journaux techniques ne contiennent pas de données personnelles au-delà du nécessaire | Lecture de `app.onError` dans [create-api.ts](../../src/bootstrap/create-api.ts) ; contrôle ciblé des journaux Vercel à effectuer | L'objet d'erreur complet est transmis à `console.error` : des détails de requête ou de contrainte peuvent contenir une valeur personnelle. Aucun masquage n'est prévu dans ce gestionnaire ; le contenu et la conservation des journaux de production restent à examiner. | non conforme |
| R10 | Après la suppression d'un compte, l'identifiant conservé ne peut plus être relié à une personne | Scan du TD10 ; tests Quests de [conservation des messages et récompenses](../../src/bootstrap/quests-privacy.test.ts#L273) et [reconstruction](../../src/bootstrap/quests-privacy.test.ts#L434) ; registre T8 | Le scan historique retrouvait déjà l'identifiant dans le journal. Avec Quests, identité et sessions sont supprimées, mais progression, participations inachevées, existence du Village, récompenses et messages restent pseudonymes. Leur durée et leurs critères de purge ne sont pas définis. Les chemins SSE contenant un identifiant peuvent aussi être corrélés aux IP des journaux ; la durée de ces journaux reste à confirmer. | non conforme |

## Synthèse

4 exigences conformes dans les scénarios documentés, 6 non conformes, 0 risque accepté
dans cette revue. Quests est intégré à l'export et au registre, sans effacement physique
de son historique pseudonyme. L'acceptation architecturale de cette conservation ne résout
pas sa conformité au RGPD.

Actions ouvertes : compléter le responsable et les emplacements manquants du registre,
réexaminer l'exhaustivité de l'export, définir et appliquer les durées et critères de purge
(Quests, sessions, journaux), puis vérifier le cron et les parcours export/suppression en
production. Voir aussi la [revue de sécurité des Quêtes](../qualite/revue-securite-quests.md).
