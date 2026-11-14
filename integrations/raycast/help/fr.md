# Utiliser Frameleaf dans Raycast

1. Installez l’extension Frameleaf dans Raycast et ouvrez **Search Photos** ou **Browse Albums**.
2. Saisissez l’adresse de votre Library, par exemple `https://photos.example.com`. Le HTTP simple ne fonctionne que pour les adresses de votre propre réseau, comme `http://192.168.1.20:2283` ; la connexion et les photos circulent alors sans chiffrement sur ce réseau.
3. Connectez-vous à votre Library dans le navigateur et choisissez les albums que Raycast peut lire, ou autorisez toute votre photothèque. Revenez à Raycast.

Sélectionnez une photo pour afficher un aperçu. Depuis le panneau d’actions, vous pouvez l’ouvrir dans Frameleaf, copier l’image ou son lien, ou la télécharger. Les téléchargements sont de grands fichiers JPEG sans position ni données de l’appareil photo et ne remplacent jamais un fichier existant.

Pour télécharger les originaux, activez **Original downloads** dans les préférences de l’extension. Votre Library vous demandera l’autorisation à la prochaine connexion ; sur n’importe quelle photo, choisissez **Allow Original Downloads** pour vous reconnecter. Les originaux conservent leur position et les données de l’appareil photo.

Une connexion directe ne nécessite pas d’abonnement Frameleaf Cloud ; le relais Frameleaf suit votre abonnement Cloud. Si votre Library n’autorise pas les applications à s’enregistrer elles-mêmes, demandez à son administrateur d’enregistrer l’adresse de retour `https://raycast.com/redirect?packageName=Extension`, puis saisissez l’identifiant client dans les préférences de l’extension.

Raycast ne voit ni les personnes, ni les lieux, ni les partages, ni les autres albums, et ne peut rien modifier ni supprimer. Modifiez ses albums dans **Applications connectées**, dans les réglages de votre Library. **Disconnect Library** révoque l’accès ; si votre Library est injoignable, Raycast conserve sa connexion pour que vous puissiez réessayer. Les photos déjà téléchargées restent sur votre ordinateur.
