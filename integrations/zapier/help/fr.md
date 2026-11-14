# Frameleaf Connect pour Zapier

Bêta privée. Les déclencheurs, recherches, actions et fichiers sont implémentés ; la qualification hébergée et la revue Zapier restent nécessaires. Ne publiez pas ce paquet.

La connexion demande library:read, library:download, albums:write, tags:write, photos:upload, boards:upload et events:read. Lors du consentement dans Frameleaf, choisissez les albums dont vous êtes propriétaire à lire, ainsi que les albums ou espaces de travail dans lesquels écrire. La lecture de toute la Library est un choix explicite. Les personnes, le partage, le retrait et la suppression ne sont jamais demandés.

Zapier doit joindre une adresse HTTPS publique de la Library. Votre propre HTTPS ne nécessite pas d’abonnement Frameleaf Cloud ; le relais Frameleaf exige un abonnement éligible. Les abonnements et limites Zapier sont distincts. L’accès limité au réseau local n’est pas pris en charge.

Dans Zapier, obtenez l’adresse de retour exacte de cette application privée. Un administrateur Frameleaf l’enregistre dans Connect et fournit l’identifiant client non secret. Saisissez l’origine canonique du serveur et cet identifiant, puis donnez votre consentement dans le navigateur. Ne collez jamais de jetons dans un champ Zap.

Les déclencheurs d’événements vérifient les 1000 événements correspondants les plus récents à chaque interrogation. Au-delà de 1000 événements entre deux interrogations, les plus anciens sont ignorés ; ce n’est pas une synchronisation sans perte.

Les actions qui créent un élément exigent un ID de source qui reste identique pour un même élément, par exemple l’ID de l’étape précédente. Les relectures, nouvelles tentatives et exécutions simultanées ne créent alors qu’un seul album ou fichier, sans doublons.

Les fichiers ne sont récupérés que lorsqu’une étape ultérieure les utilise, avec l’accès actuel de la connexion. Révoquer l’accès dans les applications connectées de Frameleaf empêche tout nouveau fichier ; cela ne supprime pas les copies déjà envoyées ailleurs. Supprimer la connexion Zapier ne révoque pas l’autorisation Frameleaf.

Avant la publication, qualifiez l’application hébergée : OAuth dans le navigateur avec le vrai rappel, plusieurs Zaps partageant une même connexion qui expire et produisant une seule rotation sûre, une réponse d’actualisation perdue, la révocation, ainsi que chaque déclencheur, recherche, action et fichier sur une Library de test.
