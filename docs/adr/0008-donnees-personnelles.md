# ADR-0008 - Stockage classique pour la Taverne et réécriture ciblée du journal pour l'effacement

- Statut : accepté
- Date : 2026-10-20

## Contexte

- La Taverne doit conserver des messages et une présence qui n'ont pas vocation à être
	conservés durablement. À l'échelle du jeu entier, les joueurs doivent aussi pouvoir
	accéder à leurs données, les exporter et en demander l'effacement.
- Des noms de joueurs sont copiés dans les événements du Donjon et du Marché ; le nom du
	village est enregistré dans les événements du Village. Ces flux peuvent contenir des
	événements concernant plusieurs joueurs.
- Le journal est en ajout seul : les événements enregistrés ne sont normalement jamais
	modifiés (ADR-0002). Les modèles de lecture dépendent de ces événements et peuvent être
	reconstruits depuis le journal (ADR-0006).
- Les données personnelles présentes dans les tables de lecture ou dans des modules sans
	journal ne sont pas nécessairement effacées par la seule suppression du compte.

## Décision

- La Taverne utilise des tables relationnelles ordinaires comme source de vérité, et non
	l'Event Sourcing. Les messages sont supprimés après trente jours ; ils ne sont aussi plus
	présentés dès que leur durée de conservation est dépassée. La présence conserve une ligne
	par joueur présent, mise à jour par un signal périodique de trente secondes ; elle est
	supprimée au départ du joueur ou lorsque son dernier signal date de plus de deux minutes.
- Le canal temps réel de la Taverne reçoit sa source de messages du module et lit la table
	des messages. Il ne dépend pas du journal d'événements. Les messages expirés et les
	présences périmées sont supprimés lors des lectures concernées et par la tâche quotidienne
	protégée par le secret des tâches planifiées.
- Chaque module et la plateforme déclarent un contributeur aux données personnelles. Il
	sait exporter les données du joueur, réécrire les champs personnels de ses événements et
	effacer les données de ses propres tables.
- L'effacement parcourt les événements candidats, puis appelle les contributeurs pour
	réécrire uniquement les champs personnels qu'ils reconnaissent. Une unique fonction de la
	plateforme réalise ces mises à jour ; elle ne modifie ni le type, ni le flux, ni la
	position, ni la version, ni les autres données de l'événement.
- Les noms copiés dans le journal sont remplacés par des libellés neutres : nom du joueur
	dans les événements du Donjon et du Marché, nom du village dans les événements du Village.
	Les identifiants des joueurs et des flux ne sont pas supprimés ; l'opération les
	pseudonymise, sans prétendre rendre le journal anonyme à elle seule.
- Les mises à jour du journal et l'entrée du registre des effacements sont atomiques. Ce
	registre ne contient que l'instant de l'effacement et le nombre d'événements réécrits,
	sans identifiant ni autre donnée sur le joueur.
- Les contributeurs effacent ensuite leurs tables, puis l'identité et ses sessions en
	dernier. Les opérations sont idempotentes afin qu'un effacement interrompu puisse être
	repris tant que le compte permet encore au joueur de s'authentifier.

## Conséquences

### Positives

- Les joueurs peuvent exercer eux-mêmes leurs droits d'accès, de portabilité et
	d'effacement depuis l'application, sans intervention manuelle sur la base.
- La pseudonymisation remplace les seuls noms personnels ciblés : les événements restent
	rejouables, les données métier des autres joueurs sont préservées et les projections
	peuvent être reconstruites à partir du journal réécrit.
- Les durées de conservation sont respectées même sans visite de la Taverne, grâce à la
	tâche quotidienne ; une lecture ne présente pas non plus un message déjà expiré en
	attendant cette tâche.
- Le stockage classique de la Taverne rend la suppression de messages et de présences
	temporaires directe, sans mécanisme de réécriture d'un historique événementiel.
- Les contributeurs rendent visible la responsabilité de chaque module sur ses données et
	permettent d'ajouter de nouvelles sections d'export ou d'effacement sans faire connaître
	les détails des modules à la plateforme.
### Négatives

- La modification ciblée du journal est une exception à son principe d'ajout seul. Toute
	évolution future doit continuer à utiliser l'unique fonction de réécriture, limiter les
	champs modifiés et préserver les invariants sur lesquels les projections et relectures
	s'appuient.
- L'export et l'effacement parcourent les données de plusieurs modules et l'effacement
	cherche dans le journal entier ; leur coût croît avec le nombre d'événements et peut
	finir par dépasser la durée maximale d'une requête.
- Chaque nouvel événement contenant une donnée personnelle doit être pris en compte dans
	le `redact` du contributeur concerné. Un champ oublié échappera à l'effacement du journal.
- Les identifiants du joueur restent dans les flux et événements nécessaires à la
	reconstruction. Ils demeurent pseudonymes, et non anonymes, tant qu'un lien avec la
	personne subsiste ailleurs ; l'effacement dépend donc de la suppression effective de
	toutes les données qui établissent ce lien.
- Le registre prouve qu'un traitement a eu lieu sans permettre de rattacher sa ligne à un
	compte ; il ne permet pas de retrouver quel joueur a été effacé.
- La suppression des messages de Taverne et la pseudonymisation de certains noms réduisent
	l'historique disponible pour les audits et les usages futurs.
## Alternatives écartées

- **Event Sourcing pour la Taverne** : rejeté, car l'expiration et le départ d'un joueur
	demanderaient de reconstruire ou de réécrire un historique pour des données éphémères,
	alors que des suppressions de lignes suffisent.
- **Supprimer les flux du joueur** : rejeté, car un flux du Donjon ou du Marché peut aussi
	contenir les actions d'autres joueurs. Le supprimer ferait perdre leur historique et
	pourrait modifier les états reconstruits ou les projections.
- **Effacement cryptographique** : rejeté, car les champs concernés sont aujourd'hui
	enregistrés en clair au milieu d'événements partagés et de tables de lecture. Il faudrait
	chiffrer séparément chaque donnée personnelle et gérer les clés ainsi que leur propagation
	dans toutes les projections ; cette approche ne permet pas de traiter directement les
	données déjà écrites.
- **Références sans copie aux noms personnels** : elles sont préférables pour les nouveaux
	modèles, mais ne corrigent pas les noms déjà copiés dans les événements existants. Elles
	auraient aussi changé le contenu de ces événements et imposé de résoudre les noms au
	moment des lectures.
- **Service externe de présence, par exemple une base clé-valeur en mémoire** : rejeté,
	car il ajouterait une infrastructure à déployer et à exploiter pour une donnée temporaire
	qui tient dans une table PostgreSQL avec expiration à la lecture et purge quotidienne.

## Réexamen

Tout nouveau module devra réexaminer l'usage de références sans copie pour les données
personnelles, plutôt que d'enregistrer des noms dans ses événements.

La décision devra aussi être revue si l'export ou la réécriture du journal approche la
durée maximale d'une requête, si la taille du journal rend l'effacement impossible en une
opération, ou si la doctrine applicable aux identifiants pseudonymes évolue.

Enfin, un besoin de présence plus fiable ou plus immédiate que le signal périodique et la
purge à la demande justifierait de réexaminer le mécanisme de la Taverne et l'infrastructure
disponible.

## Usage de l'IA générative

GitHub Copilot a aidé à structurer et rédiger cet ADR à partir de la consigne. Les choix et
leurs limites ont été recoupés avec les ADR-0002 et ADR-0006, les contributeurs de données
personnelles des modules, le service de confidentialité et les implémentations de la
Taverne.