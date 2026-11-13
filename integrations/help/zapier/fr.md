# Frameleaf Connect pour Zapier

Base de connexion uniquement. Actions, recherches, fichiers et déclencheurs ne sont pas encore disponibles. Ne publiez pas ce paquet et ne l’utilisez pas en production.

Cette connexion de qualification demande uniquement library:read. Choisissez précisément vos albums dans le consentement Frameleaf ; la lecture de toute la photothèque nécessite un choix explicite. Aucun original, personne ou droit d’écriture n’est demandé.

Zapier doit joindre une adresse HTTPS publique de la Library. Votre propre HTTPS ne nécessite pas d’abonnement Frameleaf Cloud ; le relais Frameleaf exige un abonnement éligible. Les abonnements et limites Zapier sont distincts. L’accès limité au réseau local n’est pas pris en charge.

Dans Zapier, obtenez l’adresse de retour exacte de cette application privée. Un administrateur Frameleaf l’enregistre dans Connect et fournit l’identifiant client non secret. Saisissez l’origine canonique du serveur et cet identifiant, puis donnez votre consentement dans le navigateur. Ne collez jamais de jetons dans un champ Zap.

L’OAuth hébergé et les renouvellements simultanés doivent être validés avant d’ajouter des fonctions. Vérifiez qu’une connexion partagée entre plusieurs Zaps ne provoque qu’une rotation sûre, conserve tous les nouveaux jetons, préserve les identifiants après une réponse incertaine et révoque correctement l’accès. Ces sources ne prouvent pas ces comportements de la plateforme.
