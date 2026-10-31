# Revue de sécurité des Quêtes quotidiennes : progression et récompenses

- Date : 2026-10-31
- Périmètre : API Quests, progression projetée, réclamations, dépôts au Village, confirmations, canal privé SSE et données personnelles.
- Références : OWASP Top 10 (A01 Broken Access Control, A04 Insecure Design, A08 Software and Data Integrity Failures), [ADR 0010](../adr/0010-daily-quests-persistence.md) et [ADR 0011](../adr/0011-daily-quests-communication.md).

Vérification locale du 31 octobre : **178 tests réussis dans 8 fichiers**, avec PGlite et
un adaptateur d'authentification de test. Le navigateur avec sessions réelles et la production
n'ont pas été vérifiés.

| N° | Exigence | Vérification | Constat | Statut |
| --- | --- | --- | --- | --- |
| Q1 | GET et POST exigent une authentification | Tests API [du POST](../../src/bootstrap/quests-api.test.ts#L58) et [des deux variantes du GET](../../src/bootstrap/quests-api.test.ts#L283) ; montage dans `src/bootstrap/create-api.ts` | Sans connexion, les deux routes renvoient `401 UNAUTHENTICATED` ; elles sont protégées par `requireUser`. | conforme |
| Q2 | Le joueur et la récompense ne peuvent pas être choisis par le client | Tests API [de falsification](../../src/bootstrap/quests-api.test.ts#L79) et [d'isolation](../../src/bootstrap/quests-api.test.ts#L306) | Les champs `playerId` et `reward` falsifiés sont sans effet : la réclamation utilise la session et le catalogue. Les paramètres du GET ne changent ni le joueur ni le jour retournés. | conforme |
| Q3 | La quête et le jour affiché sont validés | Tests API [des entrées](../../src/bootstrap/quests-api.test.ts#L65) et [de vue périmée](../../src/bootstrap/quests-api.test.ts#L124) | Jour absent ou impossible : `400` ; quête inconnue : `404`. Une vue périmée reçoit `409 NOT_CURRENT_DAY`, sans réclamer la quête du nouveau jour. | conforme |
| Q4 | Seule une quête achevée, avec un Village, est réclamable pendant son jour UTC | [Tests du domaine](../../src/modules/quests/domain/claim.test.ts) et [d'expiration après rattrapage ou conflit](../../src/modules/quests/infrastructure/claim-persistence.test.ts#L188) | Les conditions manquantes sont refusées. Une réclamation est acceptée jusqu'à la dernière milliseconde du jour ; à minuit, elle est refusée, même après rattrapage ou reprise sur conflit. | conforme |
| Q5 | Une récompense n'est acceptée qu'une fois par joueur, jour et quête | [Test de demandes concurrentes et répétées](../../src/modules/quests/infrastructure/claim-persistence.test.ts#L126) | Deux demandes synchronisées produisent un succès et `ALREADY_CLAIMED`, avec un seul événement et un seul message de dépôt. Une répétition est également refusée. | conforme |
| Q6 | L'acceptation et la demande de dépôt sont atomiques ; le rejeu ne redistribue rien | Tests [d'échec d'insertion](../../src/modules/quests/infrastructure/claim-persistence.test.ts#L158) et [de reconstruction](../../src/modules/quests/infrastructure/claim-persistence.test.ts#L276) | L'échec de la boîte d'envoi annule l'acceptation. Deux reconstructions ne changent ni les réclamations ni les messages existants. | conforme |
| Q7 | Dépôts et confirmations sont idempotents et corrélés | [Test du dépôt Village](../../src/modules/realm/domain/transfers.test.ts#L70) et [tests des confirmations](../../src/modules/quests/infrastructure/claim-persistence.test.ts#L220) | Un dépôt répété ne crée aucun nouvel événement ; les confirmations concurrentes ne créent qu'un `QuestRewardDelivered`. Issue autre que `deposited`, réclamation absente ou transfert incorrect : rejet. | conforme |
| Q8 | SSE et `/events` isolent le joueur et masquent les données de jeu | [Tests d'autorisation, de filtrage et de réponses SSE](../../src/bootstrap/quests-realtime.test.ts) | Sans connexion : `401` ; canal `quests-bob` : `403`. Seules les notifications du joueur passent, sous forme `QuestsChanged`, flux `quests`, données vides. Les positions globales restent visibles. | conforme |
| Q9 | Seuls les participants légitimes reçoivent de la progression | Tests de projection [Marché](../../src/modules/quests/infrastructure/progress-projection.test.ts#L366), [Donjon](../../src/modules/quests/infrastructure/progress-projection.test.ts#L667) et [préfixes Village](../../src/modules/quests/infrastructure/progress-projection.test.ts#L118) | Les compagnons sont exclus. Après refus puis nouvelle acceptation, seuls le vendeur et l'acheteur ayant réussi sont crédités ; les préfixes inattendus sont ignorés. | conforme |
| Q10 | L'export ne contient que les données Quests du demandeur | Tests d'export [des participations](../../src/bootstrap/quests-privacy.test.ts#L181), [des réclamations](../../src/bootstrap/quests-privacy.test.ts#L273) et [de progression](../../src/bootstrap/quests-privacy.test.ts#L356) | Les joueurs restent isolés. Les participations omettent les identifiants des contreparties et les montants échangés ; les données Quests ne copient aucun nom. | conforme |
| Q11 | La conservation après effacement reste explicite, même après reconstruction | Tests [d'effacement et de reconstruction](../../src/bootstrap/quests-privacy.test.ts#L434), [de règlement après suppression](../../src/bootstrap/quests-privacy.test.ts#L273) ; `src/modules/quests/personal-data.ts` | Identité et sessions supprimées, noms neutralisés ; progression, participations, existence du Village et récompenses restent pseudonymes, y compris après reconstruction. Les récompenses acceptées peuvent encore être versées. Ni effacement physique ni anonymisation complète ; aucune échéance de conservation définie. | risque accepté |

## Synthèse

10 exigences conformes dans les scénarios locaux vérifiés, 0 non conforme constatée,
1 risque architectural accepté (Q11). L'absence de durée de conservation reste à examiner :
faire valider sa justification et définir une échéance ou des critères de purge. Ce choix
architectural ne constitue pas une conclusion de conformité au RGPD.

Conserver les tests de non-régression et prévoir le traitement des lettres mortes ; les limites
de livraison, de projection et de reprise SSE sont décrites dans les ADR 0010 et 0011.
Avant validation du déploiement, vérifier avec deux comptes réels l'authentification,
l'isolation API/SSE, les reconnexions, la livraison, l'export et l'invalidation de session
après suppression, ainsi que les migrations et la distribution planifiée.
