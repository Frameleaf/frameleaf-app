# Publier depuis Lightroom Classic

1. Téléchargez le ZIP du module Frameleaf, décompressez-le, puis dans Lightroom Classic, choisissez **Fichier → Gestionnaire de modules externes → Ajouter**. Sélectionnez `frameleaf.lrplugin`.
2. Dans le panneau **Services de publication**, cliquez sur **Configurer** à côté de Frameleaf. Saisissez l’adresse de votre bibliothèque, par exemple `https://photos.example.com` ou `http://192.168.1.20:2283`. Laissez **ID de l’application** vide, sauf si votre administrateur a enregistré Lightroom pour vous.
3. Cliquez sur **Connecter…**. Votre navigateur ouvre Frameleaf. Connectez-vous, choisissez les albums auxquels Lightroom peut ajouter des photos et autorisez la création de nouveaux albums si vous voulez que chaque collection ait son propre album. Quand le navigateur revient à Lightroom, la boîte de dialogue affiche **Connecté**.
4. Créez une collection publiée. Dans ses paramètres, choisissez un album Frameleaf existant ou laissez **Créer un nouvel album**. Faites glisser des photos, puis cliquez sur **Publier**.

Lightroom envoie des JPEG sRGB avec leur titre, leur légende, leurs mots-clés et leurs droits d’auteur. La localisation est retirée, sauf si vous cochez **Inclure la localisation**, et les étiquettes de personnes ne sont jamais envoyées. Cochez **Ajouter les mots-clés Lightroom comme étiquettes Frameleaf** avant de vous connecter pour étiqueter aussi les photos dans Frameleaf.

Frameleaf conserve chaque copie que vous publiez. Republier une photo retouchée ajoute une nouvelle copie à côté de la précédente. Retirer une photo ou une collection dans Lightroom ne supprime jamais rien de Frameleaf.

Se connecter depuis votre réseau domestique ou avec votre propre adresse HTTPS ne nécessite pas d’abonnement Frameleaf Cloud. Se connecter via le relais Frameleaf nécessite un abonnement qui inclut l’accès à distance.

Si Lightroom indique que la connexion a pris fin, ouvrez les paramètres du service de publication et cliquez de nouveau sur **Connecter…**. **Déconnecter** déconnecte Lightroom et supprime son accès dans Frameleaf ; vous pouvez aussi retirer Lightroom dans Frameleaf sous **Paramètres › Votre connexion et votre confidentialité › Applications connectées**.
