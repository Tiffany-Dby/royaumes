# ADR-0009 - Extraire le Village en service autonome, sans le déployer

- Statut : accepté
- Date : 2026-10-21

## Contexte

- L'ADR-0001 promet des frontières de modules assez strictes pour permettre l'extraction
	d'un module en service autonome, tout en conservant un monolithe modulaire comme
	architecture du projet.
- Les raisons d'extraire un module sont une capacité ou un rythme de déploiement propres, ou
	le besoin de faire travailler plusieurs équipes indépendamment. Aujourd'hui, le jeu est
	développé par une personne, vise un nombre modeste de joueurs et s'appuie sur les offres
	gratuites de Vercel et Neon ; aucun besoin observé ne justifie encore ces coûts et cette
	séparation opérationnelle.
- Le Village est encapsulé dans son module pour ses appels directs, mais deux dépendances ne
	passent pas par son code : le Classement lit ses événements dans le journal commun, et le
	canal temps réel du Village lit lui aussi ce journal. Une extraction doit donc maintenir
	ces intégrations indirectes.
- Le Marché coopère avec le Village par messages de saga ; l'extraction doit préserver les
	garanties de la boîte d'envoi et les mouvements de ressources déjà définis par l'ADR-0007.

## Décision

- Le module Village est préparé pour pouvoir s'exécuter dans un service autonome disposant
	de sa propre base de données, de son propre journal d'événements et de sa propre boîte
	d'envoi.
- Dans ce mode, l'application devient une passerelle : elle fournit au reste du système un
	module distant de même forme que le module local. Les routes publiques, les gestionnaires
	de messages, la politique du canal et le contributeur de données personnelles restent
	disponibles derrière cette façade.
- Les messages destinés au Village franchissent la frontière par une boîte de réception
	protégée. Le service n'acquitte un message qu'après traitement réussi ; en cas d'échec,
	la boîte d'envoi de l'émetteur conserve ses règles habituelles de bail et de nouvelle
	tentative.
- Un relais lit les événements publiés par le service Village et en recopie les flux dans
	le journal de l'application. Le Classement et le canal temps réel continuent ainsi de lire
	leurs sources habituelles ; les copies conservent le nom du flux et sa version, et le
	relais est idempotent.
- Les appels entre processus sont authentifiés par un secret partagé transmis par
	configuration d'environnement. Il n'est jamais versionné. L'application authentifie le
	joueur puis transmet son identifiant et son nom au service dans des en-têtes de confiance.
- Le service autonome n'est pas déployé. En production, le Village s'exécute dans le
	processus de l'application ; le mode distant est sélectionné seulement si
	`REALM_SERVICE_URL` et `SERVICE_SECRET` sont tous deux configurés.

La façade et le relais sont principalement mis en œuvre dans
[`remote.ts`](../../src/modules/realm/remote.ts), le service dans
[`village-service.ts`](../../src/services/village/village-service.ts) et le choix du mode
d'exécution dans [`server.ts`](../../src/bootstrap/server.ts).

## Conséquences

### Positives

- Les frontières du monolithe sont démontrées par un service réellement exécutable, plutôt
	que seulement supposées à partir de l'organisation du code.
- Six tests de contrat vérifient les requêtes, l'authentification du service, le relais vers
	le Classement, les échanges du Marché, la reprise après panne et les droits RGPD.
- Le mode distant peut être activé ou désactivé par configuration ; les événements relayés
	permettent de conserver une copie dans le journal de l'application et rendent le retour au
	mode local réversible sans migration du modèle d'écriture.
- La boîte de réception et l'authentification interservices forment des mécanismes de
	plateforme réutilisables pour l'extraction éventuelle d'autres modules.
- Les tests et la démonstration permettent de mesurer le coût réel d'une extraction avant
	d'engager une infrastructure de production distincte.
### Négatives

- Deux chemins d'exécution du Village doivent être maintenus et testés : dans le processus
	de l'application et dans un service distant.
- Les événements sont copiés dans le journal de l'application après leur enregistrement dans
	le service. Cette cohérence est différée ; pendant le retard ou une panne du relais, les
	vues du Classement et les notifications temps réel peuvent être en retard.
- Des dettes consignées dans la revue de la partie 5.2 doivent être remboursées avant tout
	déploiement du service autonome ; les tests de contrat ne suffisent pas à garantir son
	exploitation en production.
- Le secret partagé donne à son détenteur le pouvoir de transmettre une identité de joueur
	au service. En cas de fuite, un tiers peut donc se faire passer pour n'importe quel joueur
	auprès du Village.
- L'extraction ajoute une base, un processus, des secrets et des opérations de déploiement
	distincts, alors que le mode local répond encore au besoin actuel.
## Alternatives écartées

- **Déployer le service autonome dès maintenant** : rejeté, car aucun besoin mesuré de
	capacité, d'équipe ou de rythme de déploiement indépendant ne compense aujourd'hui le coût
	d'exploitation et les dettes restantes.
- **Ne pas extraire le Village et laisser les frontières à l'état d'hypothèse** : rejeté,
	car le projet veut vérifier la promesse de l'ADR-0001 et éprouver les contrats nécessaires
	à une séparation future, sans pour autant déployer le service.
- **Faire lire directement au Classement et au canal temps réel le flux distant publié** :
	rejeté, car ces consommateurs devraient connaître l'adresse et le protocole du service,
	gérer ses pannes et sa disponibilité ; le relais conserve leurs dépendances actuelles au
	journal local.
- **Extraire le Marché à la place du Village** : rejeté, car sa saga coordonne les
	prélèvements et livraisons du Village ; l'extraction ferait franchir la frontière à
	davantage d'étapes critiques et augmenterait le couplage opérationnel.
- **Authentifier les échanges par jetons signés ou TLS mutuel** : rejeté pour cette étape,
	car cela ajouterait la gestion des clés, certificats ou autorisations par jeton sans besoin
	opérationnel actuel qui justifie cette complexité. Le secret partagé reste une limite
	explicite et doit être protégé comme un secret de production.

## Réexamen

Le déploiement devra être réexaminé si des mesures montrent que la charge du Village dépasse
son budget de latence ou de ressources alors que les autres modules le respectent, si une
seconde équipe devient responsable du Village, ou si le besoin de déployer ce module plus
souvent que le reste du jeu devient concret.

La décision devra aussi être réévaluée si les limites de Vercel ou de la base partagée
bloquent une évolution mesurée, ou si l'exploitation du relais, de l'inbox et du secret
partagé atteint un niveau de fiabilité et de supervision suffisant pour la production.

## Usage de l'IA générative

GitHub Copilot a aidé à structurer et rédiger cet ADR à partir de la consigne. La coexistence
avec l'ADR-0001 et le statut non déployé ont été vérifiés dans `server.ts` ; les garanties,
frontières et limites décrites ont été recoupées avec `remote.ts`, le service Village et les
tests de contrat.