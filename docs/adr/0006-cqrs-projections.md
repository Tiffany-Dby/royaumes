# ADR-0006 - Séparer les modèles de lecture du modèle d'écriture, avec des projections rattrapées à la lecture

- Statut : accepté
- Date : 2026-10-20

## Contexte

- Certaines lectures traversent plusieurs flux : le classement agrège l'activité du Village
	et du Donjon, et la liste des expéditions ouvertes est calculée à partir de tous les flux
	du Donjon. Le coût de cette dernière lecture croît avec l'historique complet du jeu, même
	si peu d'expéditions sont ouvertes (dette DT-005).
- L'hébergement ne fournit pas de processus permanent ni de tâche de fond fiable ; ses
	tâches planifiées gratuites ne s'exécutent qu'une fois par jour (ADR-0004).
- Le journal reste la source des événements. Chaque événement reçoit une position globale,
	croissante mais non continue, en plus de sa version propre au flux (ADR-0002).
- Les tables du modèle de lecture sont dérivées des événements : elles doivent pouvoir être
	remplies progressivement et reconstruites à partir du journal.

## Décision

- Les décisions métier continuent de s'appuyer sur le modèle d'écriture reconstruit à partir
	des événements. Les lectures transversales s'appuient sur des modèles de lecture dédiés,
	placés dans le schéma PostgreSQL du module qui les possède.
- Chaque modèle de lecture est construit par une projection. Son point de reprise et sa
	version sont enregistrés dans `platform.projections`.
- Une projection est rattrapée au moment où son modèle de lecture est consulté. Le
	rattrapage, les écritures dans le modèle et l'avancement du point de reprise ont lieu dans
	une seule transaction ; le point de reprise est verrouillé pendant cette transaction afin
	de sérialiser les rattrapages concurrents.
- Le parcours suit l'ordre global des positions du journal. Si une position manque avant un
	événement âgé de moins de cinq secondes, le rattrapage s'arrête à cet endroit. Lorsque
	l'événement qui suit le trou a au moins cinq secondes, la projection franchit le trou.
- Chaque projection possède une version. Si le code a une version supérieure à celle du
	point de reprise, ses tables sont vidées puis reconstruites depuis le journal. Si le code
	a une version inférieure, il n'écrit pas dans des tables construites par une version plus
	récente.
- Le Classement annonce les événements pertinents sur un canal global et discret. Après une
	notification, le navigateur relit le classement jusqu'à ce que la position annoncée soit
	atteinte par la projection.

## Conséquences

### Positives

- Une fois le rattrapage courant effectué, le coût d'une lecture dépend du modèle de lecture
	et des nouveaux événements, plutôt que de tout l'historique du jeu.
- Les modules qui écrivent dans le journal n'ont pas à connaître les projections qui lisent
	leurs événements ; les modèles de lecture peuvent agréger plusieurs flux sans couplage
	dans les commandes métier.
- De nouvelles informations historiques peuvent être calculées depuis les événements déjà
	enregistrés, sans migration de l'historique ni modification de sa source de vérité.
- Une projection peut être reconstruite automatiquement après une évolution de sa version,
	sans opération manuelle ni tâche de fond après un déploiement.
- L'application n'a besoin ni d'un processus permanent abonné au journal, ni d'un mécanisme
	externe de planification pour faire avancer ses modèles de lecture.
- Les tables et le point de reprise étant validés dans la même transaction, une erreur
	pendant l'application d'un événement n'expose pas une projection partiellement avancée.
### Négatives

- La cohérence est à terme : un modèle de lecture peut rester en retard sur le journal,
	notamment pendant le délai de grâce appliqué à une position manquante.
- Une reconstruction est exécutée pendant une consultation et relit le journal depuis le
	début. Sa durée est soumise à la limite d'exécution des fonctions Vercel ; elle finira par
	dépasser cette limite si le journal atteint une taille suffisante.
- Après un retour à une version précédente de l'application, le code dont la version est
	inférieure à celle enregistrée dans `platform.projections` n'avance plus la projection.
	Elle reste ainsi bloquée jusqu'au déploiement d'un code portant une version au moins égale.
- Le Classement dépend du langage publié des événements des autres modules. Un événement
	ajouté ou modifié sans réexamen de ses lecteurs peut laisser les données agrégées
	incomplètes ou incorrectes ; l'évolution des événements du Donjon a notamment affecté la
	liste des expéditions ouvertes.
- Le verrouillage du point de reprise sérialise les consultations qui rattrapent la même
	projection ; un nombre élevé de lectures simultanées peut donc créer de l'attente.
- Le traitement des positions manquantes peut retarder l'avancement et donc la visibilité
	d'une mise à jour, même si les événements suivants sont déjà présents.
## Alternatives écartées

- **Mettre à jour les modèles de lecture dans la commande du module écrivain** : rejeté,
	car les commandes devraient connaître les besoins de chaque lecteur et les écritures
	d'événements et de projections deviendraient couplées.
- **Tâche planifiée** : rejetée, car l'offre d'hébergement ne permet pas une fréquence
	adaptée et le rafraîchissement dépendrait d'un mécanisme distinct du chemin de lecture.
- **Processus de fond abonné au journal** : rejeté, car l'hébergement ne permet pas de
	processus permanent et plusieurs instances ne partagent pas leur mémoire.
- **Vue matérialisée PostgreSQL recalculée à chaque rafraîchissement** : rejetée, car elle
	relirait l'ensemble des données à chaque consultation au lieu d'appliquer seulement les
	événements nouveaux.
- **Maintenir le calcul par rejeu à chaque lecture** : rejeté, car son coût croît avec
	l'historique complet, y compris pour une liste ne contenant que quelques expéditions
	ouvertes (dette DT-005).

## Réexamen

La décision devra être réexaminée si la reconstruction d'une projection approche la durée
maximale d'exécution d'une fonction Vercel, ou si la taille du journal rend cette
reconstruction impossible dans une consultation.

Elle devra également être réévaluée si le nombre de consultations simultanées fait du
verrouillage du point de reprise un goulet d'étranglement, ou si un usage exige une lecture
strictement à jour plutôt qu'une cohérence à terme. La disponibilité d'un service fiable de
tâches de fond ou d'une autre infrastructure durable constitue aussi un motif de réexamen.

## Usage de l'IA générative

GitHub Copilot a aidé à structurer et rédiger cet ADR à partir de la consigne. Les
contraintes et mécanismes décrits ont été recoupés avec les ADR-0002 et ADR-0004, la dette
DT-005 et le code du moteur de projections, du Classement et de la liste des expéditions
ouvertes.