# Importer des images Frameleaf

1. Installez et activez le ZIP Frameleaf Connect dans WordPress.
2. En tant qu’administrateur, ouvrez **Médias → Frameleaf** et ajoutez l’origine HTTPS de votre Library. N’autorisez le réseau privé que pour votre propre Library. Si l’enregistrement automatique est désactivé, enregistrez l’adresse de retour exacte affichée dans Frameleaf Connect et saisissez son ID client.
3. Chaque rédacteur choisit **Connecter Frameleaf** et autorise les albums sélectionnés. L’adresse de retour WordPress doit utiliser un certificat HTTPS reconnu.
4. Dans le sélecteur de médias de Gutenberg ou de l’éditeur classique, choisissez **Frameleaf**. Parcourez un album ou recherchez une image, acceptez la copie locale et importez-la. Modifiez la légende et le texte alternatif avec les commandes WordPress.

Les images JPEG, PNG et WebP importées deviennent des fichiers joints WordPress, avec la visibilité habituelle du site. Elles restent après déconnexion ou révocation de l’accès. Aucune synchronisation ni suppression en arrière-plan n’a lieu. Un nouvel import télécharge le rendu actuel pour comparer son SHA-256 : un contenu identique réutilise la pièce jointe, un contenu modifié crée une nouvelle copie.

Le serveur WordPress doit pouvoir joindre la Library et reconnaître son certificat. Un accès HTTPS local ou fourni par le client ne nécessite pas d’abonnement Frameleaf Cloud ; le relais Frameleaf nécessite son abonnement habituel. Les fichiers doivent respecter la limite WordPress et la limite du plugin de 16 Mio / 40 mégapixels.

En cas de déconnexion, vérifiez l’adresse et le certificat, puis reconnectez-vous. Une actualisation incertaine impose une reconnexion. La déconnexion réessaie la révocation et conserve les identifiants chiffrés jusqu’à sa réussite. Après modification des clés ou sels WordPress, révoquez l’accès dans Frameleaf, confirmez-le ici et choisissez **Réinitialiser après un changement de clé WordPress**.

Un échec d’import supprime les données temporaires. Une publication interrompue avec un reçu incertain bloque les doublons automatiques. Demandez à l’administrateur de vérifier le fichier joint local et l’enregistrement `frameleaf_imports` en attente avant toute récupération. Ne supprimez jamais ces enregistrements sans vérification. Assistance : support@frameleaf.app.

Frameleaf nécessite PHP cURL avec prise en charge HTTPS et un accès réseau direct à la Library. Les requêtes vers la Library n’utilisent pas de proxy HTTP.
