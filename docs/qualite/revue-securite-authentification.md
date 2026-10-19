# Revue de sécurité du parcours d'authentification

- Date : 2026-10-20
- Périmètre : inscription, connexion, déconnexion, sessions, accès à l'API et aux pages du jeu.
- Références : OWASP Top 10, OWASP ASVS.

| N° | Exigence | Vérification | Constat | Statut |
| --- | --- | --- | --- | --- |
| S1 | Les mots de passe ne sont conservés que sous forme d'empreinte, par une fonction dédiée | Test « ne conserve qu'une empreinte du mot de passe » ; documentation de Better Auth | Le test trouve une valeur en base, différente du mot de passe fourni ; Better Auth effectue le hachage avant la création du compte. | conforme |
| S2 | Les mots de passe comportent au moins 8 caractères | Test « refuse un mot de passe trop court » | Le test vérifie qu'un mot de passe de 5 caractères est rejeté avec le statut 400 ; `minPasswordLength` vaut 8. | conforme |
| S3 | Les tentatives répétées d'inscription et de connexion sont limitées | Sous-partie 2.3 ; configuration de `better-auth.ts` | Limites configurées à 40 inscriptions et 60 connexions par fenêtre de 60 secondes. `AUTH_RATE_LIMIT=off` les désactive hors Vercel ; cette possibilité n'est pas restreinte au développement dans le code. | non conforme |
| S4 | Le cookie de session est inaccessible au JavaScript de la page | Test sur l'attribut `HttpOnly` | Le test vérifie la présence de `HttpOnly` sur le cookie de session. | conforme |
| S5 | Le cookie de session n'est pas envoyé par les requêtes émises depuis un autre site | Test sur l'attribut `SameSite` | Le test observe `SameSite=Lax`. Cette valeur limite l'envoi intersite, mais autorise le cookie lors de certaines navigations de premier niveau ; l'exigence absolue n'est donc pas satisfaite. | non conforme |
| S6 | Le cookie de session ne circule que sur des connexions chiffrées | Inspection du cookie dans le navigateur ; comportement en local et en production | Better Auth ne pose `Secure` que si l'URL de base est HTTPS. `BETTER_AUTH_URL` est facultative et l'URL de repli est HTTP ; le cookie n'est donc pas garanti sécurisé en production sans configuration et vérification du déploiement. | non conforme |
| S7 | Le secret de signature n'est pas versionné, et son absence en production empêche le démarrage | `git grep BETTER_AUTH_SECRET` ; fonction `resolveSecret` | `git grep` ne trouve le nom que dans `.env.example` et le code ; `.env.local` n'est pas suivi par Git. En revanche, l'absence du secret ne bloque que sur Vercel en production : ailleurs, le secret fixe de développement est utilisé. | non conforme |
| S8 | La connexion ne révèle pas si une adresse est inscrite | Test « répond de la même manière que l'adresse existe ou non » | Pour un mauvais mot de passe et une adresse inconnue, le test compare les statuts et les corps JSON, qui sont identiques. Le temps de réponse n'est pas mesuré. | conforme |
| S9 | L'inscription ne révèle pas si une adresse est inscrite | Création d'un compte avec une adresse déjà utilisée | Avec la configuration actuelle, Better Auth renvoie une erreur `422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` si l'adresse existe ; aucun mode de réponse générique n'est configuré. | non conforme |
| S10 | Toute route de l'API réservée aux joueurs refuse une requête anonyme | Tests « Contrôle d'accès à l'API du Village » ; racine de composition | Les tests vérifient qu'une lecture et une commande anonymes sur le Village renvoient 401 ; le middleware est monté sur `/realm/*`. La route de santé reste publique. | conforme |
| S11 | Un joueur ne peut accéder qu'à ses propres données | Test « isole les villages des joueurs » ; origine de `userId` dans les routes | Le test observe des villages distincts pour Alice et Bob ; les routes transmettent au service le `userId` établi par le middleware d'authentification. | conforme |
| S12 | Les pages du jeu sont protégées sur le serveur, avant tout rendu | Mise en page `app/(jeu)/layout.tsx` ; accès à `/village` sans session | La mise en page, dynamique, vérifie la session côté serveur avant de rendre ses enfants et redirige vers `/login` si aucun utilisateur n'est trouvé. | conforme |
| S13 | Les erreurs imprévues ne révèlent aucun détail technique au client | Gestionnaire `onError` de la racine de composition | Le gestionnaire journalise l'erreur côté serveur et renvoie au client uniquement `INTERNAL` et « Erreur interne ». | conforme |
| S14 | La déconnexion invalide la session sur le serveur | Réutilisation d'un cookie après déconnexion | Better Auth supprime la session en base et le cookie ; toutefois, l'échec de suppression est intercepté et n'empêche pas une réponse de succès. Aucun test de réutilisation du cookie après déconnexion n'est présent. | non conforme |
| S15 | Une requête d'authentification accompagnée d'un cookie et émise depuis une autre origine est refusée | Appel de la déconnexion avec un en-tête `origin` étranger | Le middleware CSRF de Better Auth valide l'origine des requêtes mutantes portant un cookie par rapport aux origines de confiance ; l'origine de base est déterminée par `BETTER_AUTH_URL` ou son URL de repli. | conforme |

## Synthèse

9 exigences conformes, 6 non conformes, 0 risque accepté.

Actions à décider : limiter la désactivation du rate limiting au développement ; imposer une URL HTTPS et un secret explicite dans tous les environnements de production ; activer une réponse générique à l'inscription d'une adresse déjà utilisée ; choisir une politique de cookie répondant à l'exigence intersite ; faire échouer la déconnexion si la suppression de session échoue et ajouter un test de réutilisation du cookie.