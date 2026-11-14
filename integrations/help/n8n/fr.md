# Connecter Frameleaf à n8n

Utilisez une installation n8n auto-hébergée en mode normal avec un seul processus. Le mode file d’attente, plusieurs workers et n8n Cloud ne sont pas pris en charge. L’interface du nœud n8n est en anglais.

1. Installez le nœud communautaire Frameleaf et ajoutez un identifiant Frameleaf OAuth2 API.
2. Copiez exactement OAuth Redirect URL. Demandez à l’administrateur de votre Library de l’enregistrer comme client public PKCE avec un rappel HTTPS de confiance.
3. Saisissez Library URL et le Client ID fourni par l’administrateur. Choisissez le profil de permissions minimal, puis connectez-vous.
4. Sélectionnez séparément les albums lisibles et les destinations d’écriture. Reconnectez-vous après toute modification de l’adresse ou des permissions.

L’accès direct sur le réseau local ou par votre HTTPS ne nécessite aucun abonnement Frameleaf Cloud. Le relais nécessite un abonnement éligible. Gardez la validation des certificats et la protection réseau de n8n activées ; autorisez uniquement votre Library si nécessaire.

Pour créer un album ou importer un fichier, associez Source ID à un identifiant stable de l’événement source. L’importation exige aussi une Source Date stable. Conservez l’identifiant, la date, le nom de fichier, le contenu et la destination lors des nouvelles tentatives. Respectez le délai Retry-After affiché. Les fichiers utilisent les champs binaires de n8n ; la taille des téléchargements est limitée selon votre réglage.

Les déclencheurs pour les nouvelles photos, les ajouts aux albums et les exports Studio arriveront dans une prochaine version. En attendant, démarrez vos workflows avec un autre déclencheur, par exemple une planification ou un webhook.

Pour déconnecter, révoquez l’accès dans Frameleaf et supprimez l’identifiant n8n. Les copies déjà enregistrées ailleurs restent disponibles. Contactez support@frameleaf.app avec l’opération et le statut HTTP, sans identifiants secrets, noms de fichiers privés ni médias.
