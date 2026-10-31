# Registre des traitements de données personnelles

Ce registre, prévu par l'article 30 du RGPD, recense les traitements de données personnelles
réalisés par Royaumes. Il est tenu à jour à chaque évolution du jeu qui ajoute, modifie ou
supprime une donnée personnelle, dans le même commit que cette évolution.

- Responsable du traitement : NOM, adresse électronique de contact.
- Date de dernière mise à jour : 2026-10-31.

## Sous-traitants

| Sous-traitant | Rôle | Localisation des données | Garanties à vérifier |
| --- | --- | --- | --- |
| Vercel | Hébergement de l'application, journaux techniques | Région de Francfort (fra1) pour les fonctions | Accord de traitement des données (DPA), transferts hors de l'Union européenne |
| Neon | Hébergement de la base de données | Région de Francfort | Accord de traitement des données (DPA), transferts hors de l'Union européenne |

## Traitements

| N° | Traitement | Finalité | Données | Personnes concernées | Base légale | Durée de conservation | Emplacement |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | Comptes des joueurs | Permettre l'accès au jeu | Nom, adresse électronique, empreinte du mot de passe, date d'inscription | Joueurs | Exécution du contrat (conditions d'utilisation du jeu) | Jusqu'à la suppression du compte | `identity.user`, `identity.account` |
| T2 | Sessions | Maintenir la connexion ; limiter les tentatives de connexion | Adresse IP, navigateur, dates de la session | Joueurs | Exécution du contrat ; intérêt légitime (sécurité) | Jusqu'à l'expiration de la session, ou la suppression du compte | `identity.session` |
| T3 | Activité de jeu | Faire fonctionner le Village, le Donjon, le Marché et le Classement | Identifiant, nom du joueur, nom du village, actions de jeu | Joueurs | Exécution du contrat | Jusqu'à la suppression du compte ; ensuite, identifiant pseudonymisé et noms remplacés (ADR 0008) | `platform.events`, `platform.outbox`, `ranking`, `dungeon`, `market` |
| T4 | Messagerie de la Taverne | Permettre aux joueurs de discuter | Contenu des messages, auteur, date | Joueurs | Exécution du contrat | Trente jours, ou jusqu'à la suppression du compte | `tavern.messages` |
| T5 | Présence dans la Taverne | Indiquer les joueurs présents | Identifiant, nom, date du dernier signal | Joueurs | Exécution du contrat | Deux minutes après le dernier signal | `tavern.presence` |
| T6 | Registre des effacements | Démontrer la réalisation des effacements | Date de l'effacement, nombre d'événements réécrits ; aucune donnée sur le joueur | Aucune personne identifiable | Obligation légale (responsabilité, article 5) | Illimitée | `platform.erasures` |
| T7 | Journaux techniques | Diagnostiquer les erreurs, assurer la sécurité | Adresse IP, adresses des requêtes, messages d'erreur | Joueurs, visiteurs | Intérêt légitime (sécurité, maintenance) | Durée fixée par l'hébergeur : à vérifier | Vercel |
| T8 | Quêtes quotidiennes | Suivre la progression, l'éligibilité, les réclamations et la livraison des récompenses | Identifiants des joueurs, jour UTC, quête, progression, existence du Village ; identifiants d'expédition et d'offre, participants ; récompense (ressource, montant), dates d'acceptation et de confirmation, identifiant de transfert | Joueurs | Exécution du contrat | Contexte de participation projeté retiré au traitement de la fin d'activité ; maintenu pour les activités inachevées. Progression, existence du Village et historique conservés sans échéance définie, y compris après suppression du compte, sous forme pseudonyme | `quests`, `platform.events`, `platform.outbox` |

L'export Quests comprend la progression, l'existence du Village, les participations au Donjon,
les rôles au Marché et les récompenses avec leurs dates et identifiants de transfert, sans noms
ni identifiants des contreparties. Les accès sont authentifiés et filtrés par joueur ; les
récompenses viennent du catalogue, l'acceptation et son message sont atomiques, les dépôts
idempotents et les confirmations contrôlées.

La justification et la durée de conservation de T8, ainsi que les critères de purge, restent
à examiner. L'acceptation architecturale de cette conservation pseudonyme ne démontre pas
la conformité au RGPD ([ADR 0010](../adr/0010-daily-quests-persistence.md),
[revue de sécurité des Quêtes](../qualite/revue-securite-quests.md)).

## Droits des personnes

| Droit | Mise en œuvre |
| --- | --- |
| Accès et portabilité (articles 15 et 20) | Page « Mes données » : export JSON de toutes les données du joueur |
| Effacement (article 17) | Page « Mes données » : suppression de l'identité et des sessions, effacement selon la politique de chaque module. Les données Quests de T8 restent pseudonymes, sans effacement physique ni anonymisation complète |
| Rectification (article 16) | Non mis en œuvre : le nom d'un joueur ne peut pas encore être modifié |
