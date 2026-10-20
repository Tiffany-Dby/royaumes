# ADR-0005 - Une intelligence artificielle déterministe, exécutée dans le domaine, sans tâche de fond

- Statut : accepté
- Date : 2026-10-20

## Contexte

- Les monstres doivent adapter leur comportement au niveau de difficulté choisi. Les
	compagnons doivent permettre de jouer une expédition en solo ou avec peu de joueurs
	humains.
- L'hébergement ne fournit aucun processus permanent ni tâche de fond (ADR-0001 et
	ADR-0004).
- L'état d'une expédition est reconstruit à partir de ses événements. Une lecture peut
	calculer une manche échue pour produire une vue à jour sans enregistrer ce calcul
	(ADR-0002 et ADR-0004).
- Les résultats du combat doivent rester reproductibles lorsque l'expédition est relue ou
	qu'une commande est rejouée après un conflit d'écriture.

## Décision

- Les décisions de l'intelligence artificielle sont des fonctions pures du domaine. Elles
	sont appelées au moment de la résolution d'une manche, avec l'état de jeu nécessaire à
	leur décision.
- Les décisions qui nécessitent un tirage au sort utilisent exclusivement le générateur
	déterministe de la manche ; elles ne disposent pas d'une source de hasard indépendante.
- Les actions des monstres et des compagnons, ainsi que les résultats calculés de la
	manche, sont enregistrés dans l'événement `RoundResolved`. La relecture applique ces
	résultats enregistrés et ne recalcule pas les décisions de l'intelligence artificielle.
- Le comportement des monstres est isolé derrière un port de stratégie. Chaque niveau de
	difficulté fournit sa propre mise en œuvre de ce port.
- Un compagnon choisit une action uniquement si au moins un joueur humain a choisi une
	action pour la manche. Un compagnon ne déclenche donc pas seul la résolution ou la
	progression du combat.
- L'équilibre du jeu est évalué par simulation de parties et protégé par des tests
	statistiques portant sur les résultats attendus.

## Conséquences

### Positives

- Les décisions étant des fonctions pures, elles sont testables sans serveur, base de
	données ni tâche de fond.
- L'enregistrement des actions calculées dans `RoundResolved` rend la relecture et la
	reconstruction de l'expédition reproductibles.
- Le calcul à la résolution d'une manche s'intègre au modèle d'échéances paresseuses et
	reste compatible avec l'hébergement sans processus permanent.
- Le port de stratégie permet d'ajouter ou de faire évoluer un niveau de difficulté sans
	mêler ce comportement au déroulement général d'une manche.
- Les simulations et tests statistiques permettent de comparer les niveaux de difficulté
	et de détecter des déséquilibres avant leur mise à disposition.
### Négatives

- Sans tâche de fond, un personnage piloté par l'ordinateur ne peut pas agir entre deux
	échéances ; sa décision attend la résolution déclenchée par les joueurs ou par une
	commande liée à l'échéance.
- La qualité de l'équilibre mesurée par simulation dépend de la règle de comportement des
	joueurs simulés. Des stratégies simulées peu représentatives peuvent masquer un
	déséquilibre en conditions réelles.
- Chaque décision doit rester compatible avec l'état reconstruit et le générateur de
	manche ; les décisions et événements doivent évoluer ensemble pour préserver la
	reproductibilité des anciennes expéditions.
- Les tests statistiques reposent sur des distributions et des tolérances. Ils peuvent
	nécessiter des simulations nombreuses et doivent éviter d'être instables ou trop coûteux
	dans la vérification continue.
- L'intelligence artificielle ne peut pas réagir instantanément à un événement du jeu :
	elle n'est appelée qu'aux points de résolution prévus par les règles.
## Alternatives écartées

- **Boucle de jeu exécutée par un processus permanent** : rejetée, car l'hébergement ne
	fournit pas de processus permanent ni de tâche de fond, et ses instances ne partagent pas
	leur mémoire (ADR-0001 et ADR-0004).
- **Décisions prises par le navigateur d'un joueur** : rejetées, car un client contrôlé par
	un joueur ne constitue pas une autorité fiable pour choisir les actions des monstres ou
	des compagnons. Les résultats pourraient varier selon le client et ne seraient pas
	garantis lors d'une relecture.
- **Recalcul des décisions lors de la relecture** : rejeté, car il faudrait réexécuter
	l'intelligence artificielle et ses tirages à chaque reconstruction. Enregistrer les
	actions dans `RoundResolved` préserve les résultats effectivement retenus et rend la
	relecture indépendante des futures évolutions des stratégies.

## Réexamen

Cette décision devra être réexaminée si le jeu exige qu'un personnage piloté par
l'ordinateur agisse en temps réel, indépendamment des actions des joueurs et des échéances.
Une telle évolution nécessiterait un mécanisme durable de déclenchement compatible avec
l'hébergement.

Elle devra aussi être réévaluée si le calcul des stratégies devient trop coûteux pour être
exécuté à la résolution d'une manche ou lors d'une lecture qui calcule une manche échue, si
les simulations ne prédisent plus les résultats observés en jeu, ou si le modèle de
reproductibilité des événements évolue.

## Usage de l'IA générative

GitHub Copilot a aidé à structurer et formuler cet ADR à partir de la consigne. Les
références et contraintes ont été recoupées avec les ADR-0001, ADR-0002 et ADR-0004 ; le
contenu reste à valider par l'auteur de la décision.