# ADR-0007 - Orchestrer les opérations intermodules en sagas avec une boîte d'envoi transactionnelle

- Statut : accepté
- Date : 2026-10-20

## Contexte

- Un échange du Marché porte sur des données détenues par trois domaines : l'offre du
	Marché et les ressources des villages du vendeur et de l'acheteur. Il faut éviter de
	créer ou de perdre des ressources si une étape échoue ou est répétée.
- Les modules ont des frontières d'encapsulation : un module ne doit pas dépendre des
	données internes d'un autre (TD2). Le Marché et le Village pourraient ensuite être
	extraits dans des services dotés de bases distinctes (TD11).
- L'hébergement sans serveur ne permet aucun processus permanent. Ses tâches planifiées
	ne sont pas assez fréquentes pour piloter chaque étape d'une opération (ADR-0004).
- Une opération intermodules comporte plusieurs écritures successives et peut être
	interrompue entre elles ; les participants ne partagent pas de transaction métier.

## Décision

- Une transaction modifie les données métier d'un seul module. Elle peut également
	enregistrer dans la boîte d'envoi de la plateforme les messages déclenchés par ses
	événements, dans cette même transaction.
- Toute opération qui modifie plusieurs modules est modélisée comme une saga. Ses étapes
	compensables, son pivot et les étapes à reprendre jusqu'à leur succès sont définis
	explicitement. Pour l'échange du Marché, la réservation des ressources du vendeur est
	compensable par leur restitution ; le prélèvement accepté du paiement de l'acheteur est
	le pivot ; la livraison aux deux villages est reprise jusqu'à son traitement ou jusqu'à
	l'abandon du message après dix tentatives.
- Le module qui porte l'opération orchestre la saga et enregistre son état dans ses propres
	événements. Les modules participants ignorent cette orchestration : ils traitent leur
	demande, puis adressent leur réponse au sujet `replyTo` fourni avec celle-ci.
- Chaque message déclenché est écrit dans la boîte d'envoi de la plateforme, dans la même
	transaction que les événements qui l'ont produit. Les gestionnaires utilisent une clé
	d'idempotence stable choisie par le demandeur ; pour un mouvement de ressources, c'est
	`transferId`.
- La livraison est garantie au moins une fois. Le distributeur réserve les messages avec un
	bail, retente les échecs avec un recul exponentiel et abandonne un message après dix
	tentatives. Les messages abandonnés restent en base, sans outil de consultation dédié.
- La distribution est déclenchée après les commandes du Marché et la consultation de sa
	liste. Une tâche planifiée protégée par `CRON_SECRET` la déclenche également une fois par
	jour ; la boîte d'envoi sert aussi à différer les rappels d'expiration des offres.

Cette décision est mise en œuvre dans le moteur de la boîte d'envoi
([`outbox.ts`](../../src/platform/outbox/outbox.ts)), le Marché et le Village.

## Conséquences

### Positives

- Aucun module n'écrit directement dans les données métier d'un autre ; chaque participant
	conserve la responsabilité de ses invariants.
- L'enregistrement atomique des événements et des messages évite qu'une étape soit
	enregistrée sans que sa demande de traitement le soit aussi.
- Une panne transitoire après cet enregistrement ne fait pas disparaître la demande ; les
	nouvelles livraisons avec la même clé d'idempotence évitent d'appliquer deux fois le
	mouvement de ressources.
- Les clés d'idempotence permettent de livrer plusieurs fois une demande sans appliquer
	plusieurs fois un même mouvement de ressources ; les reprises ne créent donc pas de
	doublons de ressources.
- Le Village peut traiter des demandes de mouvement provenant d'autres modules sans
	connaître l'existence ni les étapes de la saga du Marché.
- La boîte d'envoi permet de différer des messages et de les utiliser comme minuteries,
	sans ajouter un processus permanent.
- L'état et les transitions de la saga sont visibles dans les événements du module qui
	l'orchestre, plutôt que répartis dans les modules participants.
### Négatives

- Les joueurs peuvent observer des états intermédiaires, par exemple une offre en
	réservation ou en règlement, pendant que la saga attend une réponse ou une livraison.
- La latence dépend de l'activité : une saga interrompue reprend à la prochaine commande ou
	consultation de la liste du Marché, ou au prochain passage de la tâche quotidienne.
- La livraison au moins une fois impose des gestionnaires idempotents et des tests couvrant
	les doublons, les interruptions et les réponses tardives.
- Après dix tentatives, un message est abandonné. Aucun outil ne permet actuellement
	d'examiner ni de rejouer ces messages (dette DT-007).
- Les messages traités sont conservés dans la boîte d'envoi ; sa table grandit sans limite
	tant qu'aucune politique de purge ou d'archivage n'est définie.
- Les reprises ne garantissent pas un délai maximal de terminaison : l'hébergement n'exécute
	la tâche planifiée qu'une fois par jour, et une panne persistante peut épuiser les
	tentatives avant qu'un opérateur puisse intervenir.
## Alternatives écartées

- **Une transaction unique englobant les données du Marché et des deux villages** : rejetée,
	car elle ferait écrire un module dans les données d'autres modules et ne serait pas
	possible après leur extraction dans des services ou bases distincts.
- **Une transaction distribuée avec validation en deux phases** : rejetée, car elle
	nécessiterait un coordinateur et des participants capables de conserver des verrous
	pendant l'attente ; ce mécanisme n'est pas adapté aux fonctions sans état ni à
	l'hébergement actuel.
- **Un appel direct du Village par le Marché, sans boîte d'envoi** : rejeté, car une panne
	entre l'écriture de l'offre et l'appel pourrait perdre la demande ; les reprises
	pourraient aussi répéter le mouvement sans clé d'idempotence durable.
- **Une saga chorégraphiée par les événements de chaque participant** : rejetée, car le
	déroulement de l'échange et ses compensations seraient dispersés entre le Marché et les
	villages, difficiles à comprendre et à faire évoluer.
- **Utiliser le journal d'événements comme boîte d'envoi** : rejeté, car le journal décrit
	les faits métier et ne fournit pas les états de livraison, les baux, les échéances, les
	tentatives et les erreurs nécessaires au distributeur.

## Réexamen

Cette décision devra être réexaminée si un module est extrait dans un service doté de sa
propre base : il faudra alors une boîte d'envoi par base et un transport fiable entre
services.

Elle devra également être revue si le volume de messages justifie un courtier dédié, si la
croissance de la table ou des messages abandonnés exige des outils de rétention et
d'exploitation, ou si la latence de distribution déclenchée par les requêtes et la tâche
quotidienne ne répond plus aux besoins du jeu.

## Usage de l'IA générative

GitHub Copilot a aidé à structurer et rédiger cet ADR à partir de la consigne. Les
frontières transactionnelles, étapes de la saga, règles d'idempotence et modalités de
distribution ont été recoupées avec le code du Marché, du Village et de la boîte d'envoi,
ainsi qu'avec les ADR-0001 et ADR-0004.